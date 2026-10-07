# Lane Q — Estimator (Phase 6): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn 14 days of Sasha's real intake and weight into one advisory expenditure number and one weekly, one-tap target proposal. The engine never writes a target, never lowers an authored floor, stays silent until it has earned the right to speak, and holds — rather than chases — when she under-logs.

**Architecture:** One pure engine (`lib/expenditure.ts`, architecture §4.3 transcribed byte-for-byte, every constant a named export) fed by one impure reader (`lib/server/expenditure.ts`) that joins `daily_totals` rows to Lane P's `weighInsKg` port. Two cron jobs write through `upsert_expenditure_estimate` (service-role only) and `target_proposals`; approval is one `security definer` transaction (`approve_target_proposal`) that writes the `target_profiles` row and both `change_log` rows via `next_change_seq`. Percent target mode (`lib/targets/percent.ts`) is one pure module shared by the client sheet and the server route, so the floor sequence has exactly one implementation. `target_profiles` and `target_proposals` join the sync entity list as pull-only rows; the client is guarded against ever enqueuing an op for either.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (DESIGN.md tokens), pnpm 11, Node 22, vitest 5 (node environment), Supabase Postgres 17, `zod` 4, `mcp-handler`, `idb`. No new dependencies. `@testing-library/react` is **not** installed and none may be added: components are covered by their pure helpers plus a manual phone gate.

**Spec paths:**
- `docs/specs/phase-6-estimator.md` (this lane's spec)
- `docs/plans/2026-09-11-phase-5-7/00-contracts.md` (frozen; §1 row Q, §3, §5, §6)
- `docs/architecture.md` §2.1, §2.2, §3.4, §3.5, §3.6, §3.7, §4.3, §4.4, §4.5, §5, §5.2, §6, §9
- `/Users/zero-suminc./projects/clients/Sasha/analysis/targets.md` (every seed and floor number; cited per use)
- `docs/plans/2026-09-10-phase-0/00-contracts.md` §2–§8, `docs/plans/2026-09-11-phase-1-2/00-contracts.md` §2–§5
- `docs/plans/2026-09-11-phase-3-4/00-contracts.md` — read for wave-3 shapes only (`DB_VERSION = 3` + the four Lane L entities in `lib/sync/**`, `vercel.json` created with the `media-sweep` cron, `ai_calls` `status`/`error`). **Lane Q codes against that file for those shapes and rebases on wave 3 before opening its PR.**
- `meal-companion/AGENTS.md`, `meal-companion/DESIGN.md`, mockup working files `~/Desktop/Sasha app/07-design/neuform-mockup/{Main,ArenaRings,MealCard}.dc.html`
- Reference only (MIT): `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`. **Nothing is ported in Lane Q** — the macro floor sequence is transcribed from architecture §3.4 and the `reason` shape is an independent re-statement, so no `NOTICE.md` row is due and `NOTICE.md` is not in Lane Q's ownership (contracts §1 row Q).

## Global Constraints

Copied from `docs/plans/2026-09-11-phase-5-7/README.md` "Global Constraints":

> Phase 0 §8, Phase 1–2 §8a, Phase 3–4 §10 (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from `auth.uid()` or the token/source row, rate-limit → identity → body, files < 400 lines, `null` ≠ `0`, provider text is data) plus: `null` is an absent observation and is never rendered as 0 or interpolated; every engine constant is a named export with a test; the engine and the coach never write a target; tool output enters a prompt only inside the untrusted envelope; every job route is rate-limit → timing-safe `CRON_SECRET` → `job_runs` lock; gates are measured and reported, never lowered.

Lane-local additions: no file outside contracts §1 row Q is created or modified on `feat/p6-estimator`; `app/api/mcp/route.ts`, `vercel.json`, `app/settings/page.tsx` and `app/page.tsx` are **integration-stage** files and appear only as diffs in "Hand-off to integration".

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261006090100_phase6_expenditure.sql` | **Create.** `week_start` + two counters, the two indexes, the RLS tightening that replaces Phase 0's `_rw` on `expenditure_estimates` and `target_proposals`, `approve_target_proposal`, `upsert_expenditure_estimate`, `job_runs` safety net. |
| `supabase/migrations/down/20261006090100_phase6_expenditure.down.sql` | **Create.** Drops only what the up file created and restores both Phase 0 `_rw` policies. |
| `lib/expenditure.ts` | **Create.** The pure §4.3 engine: named constants, `isQualifiedDay`, `weightTrend`, the seven clamp steps, `confidenceFor`, `estimateExpenditure`, `blockedFrom`. |
| `lib/expenditure.fixtures.ts` | **Create.** Seeded-LCG synthetic series (six scenarios) + `replayScenario`, shared by the backtests and the script. |
| `lib/targets/percent.ts` | **Create.** `percentToGrams`, `applyFloors` (§3.4 steps 1–6), `validatePercentProfile`, `resolveProfileMacros`. |
| `lib/proposal.ts` | **Create.** `buildProposal` — kcal from TDEE and `goal_rate_bp_week`, protein frozen, floors, step cap, blocked. |
| `lib/api-types.ts` | **Create.** The Phase 6 spec wire types + the `TargetProfile` row type + `ProposedTargets`. |
| `lib/server/expenditure.ts` | **Create.** `runEstimate` (daily_totals → `IntakeDay`, Lane P port → `WeighIn`, upsert via RPC), `latestEstimate`. |
| `lib/server/targets.ts` | **Create.** `activeTargets`, `rampTargets`, `floorsFor`, `authorTargets` (floors re-applied server-side). |
| `lib/server/proposals.ts` | **Create.** `listProposals`, `decideProposal` (approve RPC / reject CAS update → 409 carrying the current row). |
| `app/api/expenditure/route.ts` | **Create.** `GET`, JWT, 60/min/user, latest estimate or burn-in nulls. |
| `app/api/targets/route.ts` | **Create.** `GET`/`POST`, JWT, 8 KB, 30/min/user, 422 naming the minimum percentage. |
| `app/api/proposals/route.ts` | **Create.** `GET`, JWT, 60/min/user, `?status=pending`. |
| `app/api/proposals/[id]/decide/route.ts` | **Create.** `POST`, JWT, 4 KB, 30/min/user, `expectedStatus` CAS. |
| `app/api/jobs/estimate/route.ts` | **Create.** Cron: rate limit → timing-safe `CRON_SECRET` → `ESTIMATOR_ENABLED` → per-user `job_runs` lock → `runEstimate`. |
| `app/api/jobs/weekly-proposal/route.ts` | **Create.** Cron: same gate chain → `buildProposal` → one proposal per user-week, older pending auto-rejected. |
| `lib/mcp/expenditure-tools.ts` | **Create.** `registerExpenditureTools`, `EXPENDITURE_TOOL_SCOPES`. |
| `lib/estimator-client.ts` | **Create.** `localStorage` caches, fetchers, online-only decide, the pull-only outbox guard, `shouldMountWeightTrend`. |
| `components/EstimatorCard.tsx` | **Create.** Four states with the spec copy, Settings, below `RampControl`. |
| `components/ProposalCard.tsx` | **Create.** Today; "Use these" / "Keep mine" ≥ 44 px; delta in words; offline disabled. |
| `components/TargetModeSheet.tsx` | **Create.** Grams/percent toggle, three steppers, live grams per day type. |
| `components/WeightTrend.tsx` | **Create.** Sparkline wrapper that mounts only past burn-in with ≥ 20 weigh-ins. |
| `scripts/backtest-estimator.ts` | **Create.** Replays every scenario and writes `docs/estimator-backtest-<date>.md`. |
| `docs/estimator-backtest-<date>.md` | **Create (generated).** The Phase 6 exit record, committed. |
| `lib/sync/types.ts` | **Modify** (L5–7 `Entity`, L10–13 `ENTITIES`). Add `target_profiles`, `target_proposals` as pull-only entities. |
| `lib/sync/keys.ts` | **Modify** (L7 `ID_KEYED`). Both entities are uuid-keyed. |
| `lib/sync/merge.ts` | **Modify** (L16 `NEVER_MERGED`). Add `target_proposals`. |
| `lib/sync/idb.ts` | **Modify** (L12 `DB_VERSION`). `3 → 4`; stores come from the existing `ENTITIES` loop. |
| `tests/expenditure/*.test.ts`, `tests/targets/*.test.ts`, `tests/proposals/*.test.ts` | **Create.** Unit, route and `[needs branch]` integration suites. |

---

## Task 1 — Migration and down file

**Files**
- Create: `supabase/migrations/20261006090100_phase6_expenditure.sql`
- Create: `supabase/migrations/down/20261006090100_phase6_expenditure.down.sql`
- Test: `tests/expenditure/migration.test.ts`

**Interfaces**
- Consumes: `next_change_seq(p_user_id uuid) returns bigint` (service-role only, `supabase/migrations/20260911000300_sync.sql:15`); `_sync_assert_caller(p_user_id uuid)` (`…000600_rpc.sql:8`); `change_log(user_id, seq, entity, entity_key, rev, op, op_id, current)`; `target_profiles`, `expenditure_estimates`, `target_proposals` exactly as `…000200_user_schema.sql:108–135`; the Phase 0 policies `expenditure_estimates_rw` and `target_proposals_rw` (`…000500_rls.sql`, pattern 1 loop).
- Produces: `approve_target_proposal(p_user_id uuid, p_proposal_id uuid) returns jsonb`; `upsert_expenditure_estimate(p_user_id uuid, p_row jsonb) returns uuid`; policies `expenditure_estimates_ro`, `target_proposals_ro`, `target_proposals_decide`; index `target_proposals_one_per_week`, `expenditure_estimates_recent`.

> **Contract change landed (land first).** `docs: phase-5-7 contract change — expenditure_estimates gains qualified_days and weigh_in_count` — contracts §3 now documents both columns. `ExpenditureResponse` carries `qualifiedDays` and `weighInCount` (spec "API changes"), and `expenditure_estimates` as Phase 0 shipped it stores neither; this migration adds two nullable integer columns, an addition, not a rename. Land that commit before/alongside Task 1's own commit.

- [ ] Write the failing test `tests/expenditure/migration.test.ts`:

```ts
// tests/expenditure/migration.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UP = readFileSync("supabase/migrations/20261006090100_phase6_expenditure.sql", "utf8");
const DOWN = readFileSync("supabase/migrations/down/20261006090100_phase6_expenditure.down.sql", "utf8");

describe("20261006090100_phase6_expenditure.sql", () => {
  it("replaces Phase 0's _rw policies on both estimator tables", () => {
    expect(UP).toContain("drop policy expenditure_estimates_rw on expenditure_estimates");
    expect(UP).toContain("drop policy target_proposals_rw on target_proposals");
    expect(UP).toContain("create policy expenditure_estimates_ro on expenditure_estimates for select to authenticated");
    expect(UP).toContain("create policy target_proposals_ro on target_proposals for select to authenticated");
    expect(UP).toContain("create policy target_proposals_decide on target_proposals for update to authenticated");
  });

  it("revokes the writes the browser must not hold", () => {
    expect(UP).toContain("revoke insert, update, delete on table expenditure_estimates from authenticated");
    expect(UP).toContain("revoke insert, delete on table target_proposals from authenticated");
  });

  it("leaves target_profiles alone — Phase 0 owns it and the user authors targets", () => {
    expect(UP).not.toContain("drop policy target_profiles_rw");
    expect(UP).not.toContain("alter table target_profiles");
  });

  it("grants approve to authenticated and the estimate upsert to service_role only", () => {
    expect(UP).toContain("grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role");
    expect(UP).toContain("revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated");
    expect(UP).toContain("grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role");
  });

  it("guards the approve function with _sync_assert_caller and writes two change_log rows", () => {
    expect(UP).toContain("perform _sync_assert_caller(p_user_id)");
    expect(UP.match(/next_change_seq\(p_user_id\)/g) ?? []).toHaveLength(2);
    expect(UP.match(/insert into change_log/g) ?? []).toHaveLength(2);
    expect(UP).toContain("'engine_proposal'");
  });

  it("adds the week key, the two counters and both indexes", () => {
    expect(UP).toContain("alter table target_proposals add column week_start date");
    expect(UP).toContain("add column qualified_days integer");
    expect(UP).toContain("add column weigh_in_count integer");
    expect(UP).toContain("create unique index target_proposals_one_per_week on target_proposals (user_id, week_start)");
    expect(UP).toContain("create index expenditure_estimates_recent on expenditure_estimates (user_id, local_date desc)");
  });

  it("down drops only what up created and restores both _rw policies", () => {
    expect(DOWN).toContain("drop function if exists approve_target_proposal(uuid, uuid)");
    expect(DOWN).toContain("drop function if exists upsert_expenditure_estimate(uuid, jsonb)");
    expect(DOWN).toContain("create policy expenditure_estimates_rw on expenditure_estimates for all to authenticated");
    expect(DOWN).toContain("create policy target_proposals_rw on target_proposals for all to authenticated");
    expect(DOWN).not.toContain("drop table");
  });
});
```

- [ ] Run it: `pnpm test tests/expenditure/migration.test.ts` — expect `ENOENT: no such file or directory, open 'supabase/migrations/20261006090100_phase6_expenditure.sql'`.
- [ ] Write `supabase/migrations/20261006090100_phase6_expenditure.sql`:

```sql
-- Phase 6 (contracts §3, spec "Data changes"). Phase 0 already created target_profiles,
-- expenditure_estimates and target_proposals (…000200_user_schema.sql) and gave all three the
-- pattern-1 _rw policy (…000500_rls.sql). This migration adds the week key the weekly job needs,
-- the two counters the ExpenditureResponse carries, the two indexes, and TIGHTENS the two
-- estimator tables to the read-only shape the spec's security table requires. target_profiles
-- keeps its _rw policy: the user authors targets, and every write goes through
-- lib/server/targets.ts so the floors are re-applied server-side.

alter table target_proposals add column week_start date not null;
alter table expenditure_estimates add column qualified_days integer;
alter table expenditure_estimates add column weigh_in_count integer;

create unique index target_proposals_one_per_week on target_proposals (user_id, week_start);
create index expenditure_estimates_recent on expenditure_estimates (user_id, local_date desc);

-- ---------- RLS: read-only to the browser, written only by the privileged boundary (§2.2) ------
drop policy expenditure_estimates_rw on expenditure_estimates;
create policy expenditure_estimates_ro on expenditure_estimates for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on table expenditure_estimates from authenticated;

drop policy target_proposals_rw on target_proposals;
create policy target_proposals_ro on target_proposals for select to authenticated
  using (user_id = (select auth.uid()));
create policy target_proposals_decide on target_proposals for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, delete on table target_proposals from authenticated;

-- ---------- the job lock (Lane P owns job_runs; this is the safety net when P has not landed) --
create table if not exists job_runs (job text not null, run_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));

-- ---------- approval: one transaction, two change_log rows (§3.7) ------------------------------
create function approve_target_proposal(p_user_id uuid, p_proposal_id uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prop     target_proposals%rowtype;
  v_proposed jsonb;
  v_active   target_profiles%rowtype;
  v_profile  target_profiles%rowtype;
  v_seq      bigint;
begin
  perform _sync_assert_caller(p_user_id);

  -- for update serialises two taps on the same proposal: the loser reads status 'approved'.
  select * into v_prop from target_proposals
    where id = p_proposal_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_prop.status <> 'pending' then
    return jsonb_build_object('status', 'conflict', 'current', to_jsonb(v_prop));
  end if;
  v_proposed := v_prop.proposed;

  select * into v_active from target_profiles
    where user_id = p_user_id and effective_from <= current_date
    order by effective_from desc, rev desc limit 1;

  -- The floors, the goal rate and the step cap carry over from the active profile; the engine
  -- never authors a floor of its own (§3.4 "authored floors > approved proposal > engine").
  insert into target_profiles (user_id, effective_from, rev, kcal_train, kcal_rest, authored_by,
      mode, protein_g, fat_g, carb_g, kcal_min, protein_g_min, fat_g_min, carb_g_min,
      goal_rate_bp_week, max_weekly_kcal_step, notes)
  values (p_user_id, coalesce(v_prop.week_start, current_date), 1,
      (v_proposed->>'kcalTrain')::integer, (v_proposed->>'kcalRest')::integer, 'engine_proposal',
      'grams', (v_proposed->>'proteinG')::numeric, (v_proposed->>'fatG')::numeric,
      (v_proposed->>'carbG')::numeric,
      coalesce(v_active.kcal_min, 1650),
      coalesce(v_active.protein_g_min, (v_proposed->>'proteinG')::numeric),
      coalesce(v_active.fat_g_min, 50), coalesce(v_active.carb_g_min, 0),
      coalesce(v_active.goal_rate_bp_week, 0), coalesce(v_active.max_weekly_kcal_step, 150),
      'Approved from proposal ' || p_proposal_id::text)
  returning * into v_profile;

  update target_proposals set status = 'approved', decided_at = now(), decided_by = p_user_id
    where id = p_proposal_id returning * into v_prop;

  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, 'target_profiles', v_profile.id::text, v_profile.rev, 'create',
          null, to_jsonb(v_profile));

  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, 'target_proposals', v_prop.id::text, 1, 'update',
          null, to_jsonb(v_prop));

  return jsonb_build_object('status', 'approved', 'target_profile_id', v_profile.id,
                            'profile', to_jsonb(v_profile), 'proposal', to_jsonb(v_prop));
end; $$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;

-- ---------- the estimate upsert: service_role only (§2.2) --------------------------------------
create function upsert_expenditure_estimate(p_user_id uuid, p_row jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  insert into expenditure_estimates (user_id, local_date, status, tdee_kcal, weight_trend_kg,
      intake_avg_kcal, intake_completeness, qualified_days, weigh_in_count, confidence, reason,
      engine_version)
  values (p_user_id, (p_row->>'local_date')::date, p_row->>'status',
      (p_row->>'tdee_kcal')::numeric, (p_row->>'weight_trend_kg')::numeric,
      (p_row->>'intake_avg_kcal')::numeric, (p_row->>'intake_completeness')::numeric,
      (p_row->>'qualified_days')::integer, (p_row->>'weigh_in_count')::integer,
      (p_row->>'confidence')::numeric, p_row->>'reason', p_row->>'engine_version')
  on conflict (user_id, local_date) do update set status = excluded.status,
      tdee_kcal = excluded.tdee_kcal, weight_trend_kg = excluded.weight_trend_kg,
      intake_avg_kcal = excluded.intake_avg_kcal,
      intake_completeness = excluded.intake_completeness,
      qualified_days = excluded.qualified_days, weigh_in_count = excluded.weigh_in_count,
      confidence = excluded.confidence, reason = excluded.reason,
      engine_version = excluded.engine_version
  returning id into v_id;
  return v_id;
end; $$;
revoke execute on function upsert_expenditure_estimate(uuid, jsonb) from public, anon, authenticated;
grant execute on function upsert_expenditure_estimate(uuid, jsonb) to service_role;
```

- [ ] Write `supabase/migrations/down/20261006090100_phase6_expenditure.down.sql`:

```sql
-- Reverses 20261006090100 exactly. It drops no table: expenditure_estimates, target_proposals and
-- target_profiles are Phase 0's, and an approved profile survives as an ordinary authored row
-- (spec "Rollout and rollback"). job_runs is Lane P's table and is left in place.
drop function if exists approve_target_proposal(uuid, uuid);
drop function if exists upsert_expenditure_estimate(uuid, jsonb);

drop policy if exists target_proposals_decide on target_proposals;
drop policy if exists target_proposals_ro on target_proposals;
create policy target_proposals_rw on target_proposals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on table target_proposals to authenticated;

drop policy if exists expenditure_estimates_ro on expenditure_estimates;
create policy expenditure_estimates_rw on expenditure_estimates for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on table expenditure_estimates to authenticated;

drop index if exists expenditure_estimates_recent;
drop index if exists target_proposals_one_per_week;
alter table expenditure_estimates drop column if exists weigh_in_count;
alter table expenditure_estimates drop column if exists qualified_days;
alter table target_proposals drop column if exists week_start;
```

- [ ] Run: `pnpm test tests/expenditure/migration.test.ts` — expect PASS (7 tests).
- [ ] `[needs branch]` Apply to a Supabase branch and confirm it is reversible (skip when `SUPABASE_TEST_DB_URL` is unset): `pnpm db:push` then `psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/down/20261006090100_phase6_expenditure.down.sql` then `pnpm db:push` again — expect three clean exits.
- [ ] Commit: `git add supabase/migrations tests/expenditure && git commit -m "feat(db): phase 6 estimator migration with RLS tightening and approve transaction"`

---

## Task 2 — Engine constants and `isQualifiedDay`

**Files**
- Create: `lib/expenditure.ts`
- Test: `tests/expenditure/constants.test.ts`

**Interfaces**
- Consumes: nothing (pure module).
- Produces: `ENGINE_VERSION`, `ALPHA`, `OUTLIER_PCT`, `MAX_GAP_DAYS`, `WINDOW_DAYS`, `BURN_IN_QUALIFIED`, `BURN_IN_WEIGH_INS`, `BURN_IN_COMPLETE`, `HELD_QUALIFIED_7`, `HELD_WEIGH_INS_7`, `PRIOR_CLAMP_PCT`, `BMR_LOW`, `BMR_HIGH`, `KCAL_PER_KG`, `ROUND_KCAL`, `PRIOR_KCAL`, `BMR_KCAL`, `MIN_ENERGY_COVERAGE`, `MIN_QUALIFIED_KCAL`, `SEED_WEIGH_INS`, `RECENT_DAYS`; `type WeighIn`, `type IntakeDay`, `type ExpenditureStatus`, `type ExpenditureInput`, `type ExpenditureResult`; `toDayNumber(date: string): number`; `fromDayNumber(n: number): string`; `isQualifiedDay(day: IntakeDay, asOf: string): boolean`.

- [ ] Write the failing test `tests/expenditure/constants.test.ts`:

```ts
// tests/expenditure/constants.test.ts
import { describe, expect, it } from "vitest";
import {
  ALPHA, BMR_HIGH, BMR_KCAL, BMR_LOW, BURN_IN_COMPLETE, BURN_IN_QUALIFIED, BURN_IN_WEIGH_INS,
  ENGINE_VERSION, HELD_QUALIFIED_7, HELD_WEIGH_INS_7, isQualifiedDay, KCAL_PER_KG, MAX_GAP_DAYS,
  MIN_ENERGY_COVERAGE, MIN_QUALIFIED_KCAL, PRIOR_CLAMP_PCT, PRIOR_KCAL, RECENT_DAYS, ROUND_KCAL,
  SEED_WEIGH_INS, toDayNumber, WINDOW_DAYS, type IntakeDay,
} from "@/lib/expenditure";

/** Contracts §9: a change to any engine constant fails at least one test, deliberately. */
describe("engine constants", () => {
  it("carries the §4.3 values and the targets.md seeds", () => {
    expect({
      ENGINE_VERSION, ALPHA, OUTLIER_PCT: 0.025, MAX_GAP_DAYS, WINDOW_DAYS, RECENT_DAYS,
      BURN_IN_QUALIFIED, BURN_IN_WEIGH_INS, BURN_IN_COMPLETE, HELD_QUALIFIED_7, HELD_WEIGH_INS_7,
      PRIOR_CLAMP_PCT, BMR_LOW, BMR_HIGH, KCAL_PER_KG, ROUND_KCAL, PRIOR_KCAL, BMR_KCAL,
      MIN_ENERGY_COVERAGE, MIN_QUALIFIED_KCAL, SEED_WEIGH_INS,
    }).toEqual({
      ENGINE_VERSION: "exp-1.0.0", ALPHA: 2 / 21, OUTLIER_PCT: 0.025, MAX_GAP_DAYS: 3,
      WINDOW_DAYS: 14, RECENT_DAYS: 7, BURN_IN_QUALIFIED: 21, BURN_IN_WEIGH_INS: 12,
      BURN_IN_COMPLETE: 15, HELD_QUALIFIED_7: 5, HELD_WEIGH_INS_7: 3, PRIOR_CLAMP_PCT: 0.1,
      BMR_LOW: 0.9, BMR_HIGH: 2.2, KCAL_PER_KG: 7700, ROUND_KCAL: 10, PRIOR_KCAL: 2130,
      BMR_KCAL: 1372, MIN_ENERGY_COVERAGE: 0.95, MIN_QUALIFIED_KCAL: 1000, SEED_WEIGH_INS: 3,
    });
  });

  it("bounds the absolute clamp at 1,235 and 3,018 kcal on the measured BMR", () => {
    expect(Math.round(BMR_LOW * BMR_KCAL)).toBe(1235);
    expect(Math.round(BMR_HIGH * BMR_KCAL)).toBe(3018);
  });
});

describe("toDayNumber", () => {
  it("counts whole days and is unaffected by the runtime time zone", () => {
    expect(toDayNumber("2026-09-11") - toDayNumber("2026-09-01")).toBe(10);
    expect(toDayNumber("2027-03-01") - toDayNumber("2027-02-28")).toBe(1);
  });
});

describe("isQualifiedDay", () => {
  const day = (over: Partial<IntakeDay> = {}): IntakeDay =>
    ({ date: "2026-09-10", kcal: 2000, energyCoverage: 1, ...over });

  it("qualifies a complete, fed day strictly before asOf", () => {
    expect(isQualifiedDay(day(), "2026-09-11")).toBe(true);
  });
  it("refuses coverage under 0.95", () => {
    expect(isQualifiedDay(day({ energyCoverage: 0.94 }), "2026-09-11")).toBe(false);
    expect(isQualifiedDay(day({ energyCoverage: 0.95 }), "2026-09-11")).toBe(true);
  });
  it("refuses a day under 1000 kcal", () => {
    expect(isQualifiedDay(day({ kcal: 999 }), "2026-09-11")).toBe(false);
    expect(isQualifiedDay(day({ kcal: 1000 }), "2026-09-11")).toBe(true);
  });
  it("refuses today and any later date — the day is not finished", () => {
    expect(isQualifiedDay(day({ date: "2026-09-11" }), "2026-09-11")).toBe(false);
    expect(isQualifiedDay(day({ date: "2026-09-12" }), "2026-09-11")).toBe(false);
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/constants.test.ts` — expect `Failed to resolve import "@/lib/expenditure"`.
- [ ] Write `lib/expenditure.ts` (first section only; Tasks 3–5 append to the same file):

```ts
/**
 * The advisory expenditure engine — architecture §4.3, transcribed, never re-derived.
 *
 * Pure: no I/O, no `Date.now()`, no randomness. Every constant is a named export with a test that
 * fails when it changes (wave-4 contracts §9), so a tuned number is always a deliberate edit.
 *
 * Seeds come from `/Users/zero-suminc./projects/clients/Sasha/analysis/targets.md` §1:
 *   PRIOR_KCAL 2130 — "Add 4 lifting sessions/wk → ×1.55 → ~2,130 kcal ← trained maintenance",
 *                     the table's "Working number".
 *   BMR_KCAL   1372 — "BMR (InBody, Katch-McArdle from 46.4 kg LBM) | 1,372 kcal".
 * 7700 kcal/kg is an explicit modelling approximation (§4.3), not a physical constant.
 */

export const ENGINE_VERSION = "exp-1.0.0";

/** 20-day EMA. §4.3: "weight_trend = 20-day EMA (α = 2/21 ≈ 0.0952)". */
export const ALPHA = 2 / 21;
/** §4.3: "outlier = |Δ| > 2.5 % of trend in one day → that weigh-in is held out". */
export const OUTLIER_PCT = 0.025;
/** §4.3: "gaps ≤ 3 days interpolate linearly; longer gaps leave the trend undefined there". */
export const MAX_GAP_DAYS = 3;
/** The estimator window: intake_avg, both completeness fractions and trend[t] − trend[t−14]. */
export const WINDOW_DAYS = 14;
/** The "last 7" window the two held conditions use. */
export const RECENT_DAYS = 7;
/** §4.3 burn-in: "≥ 21 qualified days" (lifetime — calendar time never ends burn-in). */
export const BURN_IN_QUALIFIED = 21;
/** §4.3 burn-in: "≥ 12 weigh-ins" (weighed days in the last 21). */
export const BURN_IN_WEIGH_INS = 12;
/** §4.3 burn-in: "≥ 15 complete intake days" (qualified days in the last 21). */
export const BURN_IN_COMPLETE = 15;
/** §4.3 held: "qualified days in the last 7 < 5". */
export const HELD_QUALIFIED_7 = 5;
/** §4.3 held: "weigh-ins in the last 7 < 3". */
export const HELD_WEIGH_INS_7 = 3;
/** Clamp step 4: "clamp it to prior ± 10 %". */
export const PRIOR_CLAMP_PCT = 0.1;
/** Clamp step 6: "clamp to 0.9 × BMR … 2.2 × BMR = 1,235 … 3,018 kcal". */
export const BMR_LOW = 0.9;
export const BMR_HIGH = 2.2;
/** §4.3 modelling approximation. */
export const KCAL_PER_KG = 7700;
/** Clamp step 7: "round to the nearest 10 kcal and store". */
export const ROUND_KCAL = 10;
/** targets.md §1 seeds. */
export const PRIOR_KCAL = 2130;
export const BMR_KCAL = 1372;
/** Qualified-day thresholds — this phase's proposal, spec open question 3 (ASSUMED). */
export const MIN_ENERGY_COVERAGE = 0.95;
export const MIN_QUALIFIED_KCAL = 1000;
/** §4.3: the EMA is "seeded with the mean of the first 3 weigh-ins". */
export const SEED_WEIGH_INS = 3;

export type WeighIn = { date: string; kg: number };
/** `energyCoverage` is `daily_totals.coverage` for `energy_kcal` (Phase 2 view, architecture §3.3). */
export type IntakeDay = { date: string; kcal: number; energyCoverage: number };
export type ExpenditureStatus = "burn_in" | "held" | "estimating" | "blocked";

export type ExpenditureInput = {
  asOf: string; weighIns: WeighIn[]; intake: IntakeDay[]; priorKcal: number; bmrKcal: number;
};

export type ExpenditureResult = {
  status: ExpenditureStatus;
  tdeeKcal: number | null;
  weightTrendKg: number | null;
  intakeAvgKcal: number | null;
  intakeCompleteness: number;
  weighInCompleteness: number;
  /** Qualified days in the last 21 (spec "API changes"). */
  qualifiedDays: number;
  /** Weighed days in the last 21. */
  weighInCount: number;
  confidence: number;
  reason: string | null;
  engineVersion: string;
};

const MS_PER_DAY = 86_400_000;

/** Whole days since the epoch for a "YYYY-MM-DD" calendar date. UTC arithmetic, so the runtime's
 *  own zone can never shift a day (the same trick `lib/plan.ts` uses). */
export function toDayNumber(date: string): number {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function fromDayNumber(dayNumber: number): string {
  const d = new Date(dayNumber * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Spec "Engines and logic": a local date is qualified when energy coverage is at least 0.95 in
 * `daily_totals`, intake is at least 1000 kcal, and the date is not today or later.
 */
export function isQualifiedDay(day: IntakeDay, asOf: string): boolean {
  return day.energyCoverage >= MIN_ENERGY_COVERAGE
    && day.kcal >= MIN_QUALIFIED_KCAL
    && toDayNumber(day.date) < toDayNumber(asOf);
}
```

- [ ] Run: `pnpm test tests/expenditure/constants.test.ts` — expect PASS (7 tests).
- [ ] Commit: `git add lib/expenditure.ts tests/expenditure && git commit -m "feat(expenditure): engine constants and the qualified-day definition"`

---

## Task 3 — `weightTrend`: outlier hold-out, seeding, gaps

**Files**
- Modify: `lib/expenditure.ts` (append below `isQualifiedDay`)
- Test: `tests/expenditure/weight-trend.test.ts`

**Interfaces**
- Consumes: `ALPHA`, `OUTLIER_PCT`, `MAX_GAP_DAYS`, `SEED_WEIGH_INS`, `toDayNumber`, `type WeighIn`.
- Produces: `weightTrend(weighIns: WeighIn[], asOf: string): (number | null)[]` — index 0 is the **first weigh-in's local date**, the last index is `asOf`, and `null` is an undefined trend point that is never rendered as 0 (Global Constraints).

- [ ] Write the failing test `tests/expenditure/weight-trend.test.ts`:

```ts
// tests/expenditure/weight-trend.test.ts
import { describe, expect, it } from "vitest";
import { ALPHA, fromDayNumber, toDayNumber, weightTrend, type WeighIn } from "@/lib/expenditure";

const START = "2026-06-01";
const at = (offset: number) => fromDayNumber(toDayNumber(START) + offset);
const series = (pairs: [number, number][]): WeighIn[] =>
  pairs.map(([offset, kg]) => ({ date: at(offset), kg }));

describe("weightTrend", () => {
  it("returns nothing until three weigh-ins exist", () => {
    expect(weightTrend(series([[0, 57.6], [1, 57.5]]), at(5))).toEqual([]);
  });

  it("seeds on the third weigh-in with the mean of the first three, and leaves earlier days null", () => {
    const trend = weightTrend(series([[0, 57.0], [1, 57.6], [2, 57.9]]), at(2));
    expect(trend).toHaveLength(3);
    expect(trend[0]).toBeNull();
    expect(trend[1]).toBeNull();
    expect(trend[2]).toBeCloseTo((57.0 + 57.6 + 57.9) / 3, 10);
  });

  it("advances by the EMA on the next accepted weigh-in", () => {
    const trend = weightTrend(series([[0, 57.0], [1, 57.6], [2, 57.9], [3, 57.5]]), at(3));
    const seed = (57.0 + 57.6 + 57.9) / 3;
    expect(trend[3]).toBeCloseTo(seed + ALPHA * (57.5 - seed), 10);
  });

  it("interpolates a 3-day gap and leaves a 4-day gap undefined there", () => {
    const three = weightTrend(series([[0, 57.5], [1, 57.5], [2, 57.5], [6, 58.0]]), at(6));
    expect(three.slice(3, 7).every((v) => v !== null)).toBe(true);

    const four = weightTrend(series([[0, 57.5], [1, 57.5], [2, 57.5], [7, 58.0]]), at(7));
    expect(four.slice(3, 7)).toEqual([null, null, null, null]);
    expect(four[7]).not.toBeNull();
  });

  it("holds out a weigh-in 2.6 % off trend and accepts one at 2.4 %", () => {
    const base = [[0, 57.5], [1, 57.5], [2, 57.5]] as [number, number][];
    const seed = 57.5;
    const held = weightTrend(series([...base, [3, seed * 1.026]]), at(3));
    expect(held[3]).toBeCloseTo(seed, 10);            // unchanged: the reading was held out

    const kept = weightTrend(series([...base, [3, seed * 1.024]]), at(3));
    expect(kept[3]).toBeCloseTo(seed + ALPHA * (seed * 1.024 - seed), 10);
  });

  it("holds the last value for at most three trailing days, then goes undefined", () => {
    const short = weightTrend(series([[0, 57.5], [1, 57.5], [2, 57.5]]), at(5));
    expect(short[5]).toBeCloseTo(57.5, 10);
    const long = weightTrend(series([[0, 57.5], [1, 57.5], [2, 57.5]]), at(6));
    expect(long[6]).toBeNull();
  });

  it("takes the last reading of a local date, like daily_health's body_mass rule", () => {
    const trend = weightTrend(
      [{ date: at(0), kg: 57.0 }, { date: at(1), kg: 57.6 }, { date: at(2), kg: 60.0 },
       { date: at(2), kg: 57.9 }], at(2));
    expect(trend[2]).toBeCloseTo((57.0 + 57.6 + 57.9) / 3, 10);
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/weight-trend.test.ts` — expect `weightTrend is not a function` (no such export).
- [ ] Append to `lib/expenditure.ts`:

```ts
/**
 * The §4.3 weight trend, one element per calendar day.
 *
 * Index 0 is the first weigh-in's local date and the last index is `asOf`, so a consumer reads
 * `trend.at(-1)` for trend[t] and `trend.at(-1 - WINDOW_DAYS)` for trend[t−14]. `null` means the
 * trend is undefined that day; it is never 0 and is never rendered (Global Constraints).
 *
 * Order, exactly §4.3's clamp step 1: reject outliers, then build the trend.
 *   1. one reading per local date — the last one wins, matching `daily_health`'s body_mass rule.
 *   2. the EMA seeds on the THIRD weigh-in with the mean of the first three; earlier days are null.
 *   3. a reading more than OUTLIER_PCT off the current trend is held out: no EMA update, and the
 *      day counts as unobserved.
 *   4. a gap of at most MAX_GAP_DAYS between two accepted readings interpolates linearly and the
 *      interpolated values feed the EMA day by day; a longer gap leaves those days undefined and
 *      the EMA resumes from its held state on the next accepted reading.
 *   5. after the last reading the trend holds for at most MAX_GAP_DAYS days, then goes undefined —
 *      which is what makes "stopped weighing" read as `held` rather than a stale number.
 */
export function weightTrend(weighIns: WeighIn[], asOf: string): (number | null)[] {
  const byDay = new Map<number, number>();
  for (const w of weighIns) byDay.set(toDayNumber(w.date), w.kg);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < SEED_WEIGH_INS) return [];

  const start = days[0];
  const end = toDayNumber(asOf);
  const span = end - start + 1;
  if (span <= 0) return [];
  const trend: (number | null)[] = new Array(span).fill(null);

  const seedDays = days.slice(0, SEED_WEIGH_INS);
  let value = seedDays.reduce((sum, day) => sum + (byDay.get(day) as number), 0) / SEED_WEIGH_INS;
  let lastDay = seedDays[SEED_WEIGH_INS - 1];
  let lastKg = byDay.get(lastDay) as number;
  const put = (day: number, v: number) => {
    const index = day - start;
    if (index >= 0 && index < span) trend[index] = v;
  };
  put(lastDay, value);

  for (const day of days.slice(SEED_WEIGH_INS)) {
    if (day > end) break;
    const kg = byDay.get(day) as number;
    if (Math.abs(kg - value) > OUTLIER_PCT * value) continue;
    const gap = day - lastDay - 1;
    if (gap > MAX_GAP_DAYS) {
      value += ALPHA * (kg - value);
      put(day, value);
    } else {
      for (let step = 1; step <= gap + 1; step += 1) {
        const observed = lastKg + ((kg - lastKg) * step) / (gap + 1);
        value += ALPHA * (observed - value);
        put(lastDay + step, value);
      }
    }
    lastDay = day;
    lastKg = kg;
  }

  for (let step = 1; step <= MAX_GAP_DAYS; step += 1) {
    if (lastDay + step > end) break;
    put(lastDay + step, value);
  }
  return trend;
}
```

- [ ] Run: `pnpm test tests/expenditure/weight-trend.test.ts` — expect PASS (7 tests).
- [ ] Commit: `git add lib/expenditure.ts tests/expenditure && git commit -m "feat(expenditure): 20-day EMA trend with outlier hold-out and gap rules"`

---

## Task 4 — The seven clamp steps and the confidence formula

**Files**
- Modify: `lib/expenditure.ts` (append below `weightTrend`)
- Test: `tests/expenditure/clamp-steps.test.ts`

**Interfaces**
- Consumes: `weightTrend`, `WINDOW_DAYS`, `KCAL_PER_KG`, `PRIOR_CLAMP_PCT`, `BMR_LOW`, `BMR_HIGH`, `ROUND_KCAL`, `BURN_IN_QUALIFIED`.
- Produces: `step1BuildTrend`, `step2TrendEndpoints`, `step3TdeeRaw`, `step4ClampToPrior`, `step5Blend`, `step6ClampToBmr`, `step7Round`, `confidenceFor`.

- [ ] Write the failing test `tests/expenditure/clamp-steps.test.ts`:

```ts
// tests/expenditure/clamp-steps.test.ts
import { describe, expect, it } from "vitest";
import {
  BMR_KCAL, confidenceFor, fromDayNumber, PRIOR_KCAL, step1BuildTrend, step2TrendEndpoints,
  step3TdeeRaw, step4ClampToPrior, step5Blend, step6ClampToBmr, step7Round, toDayNumber,
} from "@/lib/expenditure";

const at = (offset: number) => fromDayNumber(toDayNumber("2026-06-01") + offset);

describe("clamp step 1 — reject outliers, then build the trend", () => {
  it("delegates to weightTrend and returns one element per day up to asOf", () => {
    const trend = step1BuildTrend(
      [0, 1, 2].map((o) => ({ date: at(o), kg: 57.5 })), at(2));
    expect(trend).toHaveLength(3);
  });
});

describe("clamp step 2 — hold if either endpoint is undefined", () => {
  it("reads trend[t] and trend[t−14] off the tail of the array", () => {
    const trend = Array.from({ length: 20 }, (_, i) => i as number | null);
    expect(step2TrendEndpoints(trend)).toEqual({ now: 19, then: 5, held: false });
  });
  it("holds when the series is shorter than the window", () => {
    expect(step2TrendEndpoints([1, 2, 3]).held).toBe(true);
  });
  it("holds when either endpoint is null and never extrapolates across the gap", () => {
    const trend: (number | null)[] = Array.from({ length: 20 }, () => 57.5);
    trend[5] = null;
    expect(step2TrendEndpoints(trend)).toEqual({ now: 57.5, then: null, held: true });
  });
});

describe("clamp step 3 — tdee_raw", () => {
  it("is intake_avg minus the 14-day trend slope in kcal", () => {
    // losing 0.14 kg over 14 days = 0.01 kg/day = 77 kcal/day of deficit
    expect(step3TdeeRaw(2000, 57.36, 57.5)).toBeCloseTo(2077, 6);
  });
});

describe("clamp step 4 — prior ± 10 %", () => {
  it("clamps above and below and passes an in-range value through", () => {
    expect(step4ClampToPrior(9999, PRIOR_KCAL)).toBeCloseTo(2343, 6);
    expect(step4ClampToPrior(0, PRIOR_KCAL)).toBeCloseTo(1917, 6);
    expect(step4ClampToPrior(2200, PRIOR_KCAL)).toBe(2200);
  });
});

describe("clamp step 5 — blend by confidence", () => {
  it("is the prior at confidence 0 and the clamped value at confidence 1", () => {
    expect(step5Blend(2343, PRIOR_KCAL, 0)).toBe(PRIOR_KCAL);
    expect(step5Blend(2343, PRIOR_KCAL, 1)).toBe(2343);
    expect(step5Blend(2330, PRIOR_KCAL, 0.5)).toBeCloseTo(2230, 6);
  });
});

describe("clamp step 6 — absolute BMR bound", () => {
  it("bounds at 1,235 and 3,018 on the measured BMR", () => {
    expect(step6ClampToBmr(900, BMR_KCAL)).toBe(1235);
    expect(step6ClampToBmr(5000, BMR_KCAL)).toBe(3018);
    expect(step6ClampToBmr(2200, BMR_KCAL)).toBe(2200);
  });
});

describe("clamp step 7 — round to 10 kcal", () => {
  it("rounds to the nearest 10", () => {
    expect(step7Round(2234)).toBe(2230);
    expect(step7Round(2235)).toBe(2240);
    expect(step7Round(2343.2)).toBe(2340);
  });
});

describe("confidenceFor", () => {
  it("is 0.5·intake + 0.3·weigh-ins + 0.2·min(qualified ÷ 21, 1)", () => {
    expect(confidenceFor(1, 1, 21)).toBeCloseTo(1, 10);
    expect(confidenceFor(0, 0, 0)).toBe(0);
    expect(confidenceFor(0.5, 0.5, 21)).toBeCloseTo(0.6, 10);
    expect(confidenceFor(1, 1, 42)).toBeCloseTo(1, 10);       // the third term caps at 1
    expect(confidenceFor(12 / 14, 10 / 14, 18)).toBeCloseTo(
      0.5 * (12 / 14) + 0.3 * (10 / 14) + 0.2 * (18 / 21), 10);
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/clamp-steps.test.ts` — expect `step1BuildTrend is not a function`.
- [ ] Append to `lib/expenditure.ts`:

```ts
/**
 * §4.3's clamp order, one exported function per numbered step, applied in this sequence and no
 * other. Each has its own test so a re-ordering or a changed coefficient fails loudly.
 */

/** (1) reject outlier weigh-ins, then build the trend. */
export function step1BuildTrend(weighIns: WeighIn[], asOf: string): (number | null)[] {
  return weightTrend(weighIns, asOf);
}

/** (2) hold if either trend endpoint is undefined — never extrapolate across a gap. */
export function step2TrendEndpoints(
  trend: (number | null)[],
): { now: number | null; then: number | null; held: boolean } {
  const nowIndex = trend.length - 1;
  const thenIndex = nowIndex - WINDOW_DAYS;
  const now = nowIndex >= 0 ? trend[nowIndex] : null;
  const then = thenIndex >= 0 ? trend[thenIndex] : null;
  return { now, then, held: now === null || then === null };
}

/** (3) tdee_raw = intake_avg − (trend[t] − trend[t−14]) ÷ 14 × 7700. */
export function step3TdeeRaw(intakeAvgKcal: number, trendNow: number, trendThen: number): number {
  return intakeAvgKcal - ((trendNow - trendThen) / WINDOW_DAYS) * KCAL_PER_KG;
}

/** (4) clamp to prior ± 10 %. */
export function step4ClampToPrior(tdeeRaw: number, priorKcal: number): number {
  const low = priorKcal * (1 - PRIOR_CLAMP_PCT);
  const high = priorKcal * (1 + PRIOR_CLAMP_PCT);
  return Math.min(high, Math.max(low, tdeeRaw));
}

/** (5) blend: tdee = prior + confidence × (clamped − prior). */
export function step5Blend(clamped: number, priorKcal: number, confidence: number): number {
  return priorKcal + confidence * (clamped - priorKcal);
}

/** (6) clamp to 0.9 × BMR … 2.2 × BMR. The bounds round to whole kcal: 1,235 … 3,018. */
export function step6ClampToBmr(value: number, bmrKcal: number): number {
  return Math.min(Math.round(BMR_HIGH * bmrKcal), Math.max(Math.round(BMR_LOW * bmrKcal), value));
}

/** (7) round to the nearest 10 kcal and store; this value is the next run's prior. */
export function step7Round(value: number): number {
  return Math.round(value / ROUND_KCAL) * ROUND_KCAL;
}

/** §4.3: confidence = 0.5 × intake_completeness + 0.3 × weigh_in_completeness
 *  + 0.2 × min(qualified_days ÷ 21, 1). Each term is already in [0,1]. */
export function confidenceFor(
  intakeCompleteness: number, weighInCompleteness: number, qualifiedDays: number,
): number {
  return 0.5 * intakeCompleteness
    + 0.3 * weighInCompleteness
    + 0.2 * Math.min(qualifiedDays / BURN_IN_QUALIFIED, 1);
}
```

- [ ] Run: `pnpm test tests/expenditure/clamp-steps.test.ts` — expect PASS (11 tests).
- [ ] Commit: `git add lib/expenditure.ts tests/expenditure && git commit -m "feat(expenditure): the seven clamp steps and the confidence formula"`

---

## Task 5 — `estimateExpenditure` and the status machine

**Files**
- Modify: `lib/expenditure.ts` (append below `confidenceFor`)
- Test: `tests/expenditure/expenditure.test.ts`

**Interfaces**
- Consumes: every export of Tasks 2–4.
- Produces: `estimateExpenditure(input: ExpenditureInput): ExpenditureResult`; `blockedFrom(result: ExpenditureResult, reason: string): ExpenditureResult`.

- [ ] Write the failing test `tests/expenditure/expenditure.test.ts`:

```ts
// tests/expenditure/expenditure.test.ts
import { describe, expect, it } from "vitest";
import {
  blockedFrom, BMR_KCAL, ENGINE_VERSION, estimateExpenditure, fromDayNumber, PRIOR_KCAL,
  toDayNumber, type ExpenditureInput, type IntakeDay, type WeighIn,
} from "@/lib/expenditure";

const AS_OF = "2026-09-11";
const back = (days: number) => fromDayNumber(toDayNumber(AS_OF) - days);

function weighIns(days: number, kg = (d: number) => 57.5 - d * 0.005, skip: number[] = []): WeighIn[] {
  const out: WeighIn[] = [];
  for (let d = days; d >= 1; d -= 1) if (!skip.includes(d)) out.push({ date: back(d), kg: kg(d) });
  return out;
}

function intake(days: number, qualified = days, kcal = 2100): IntakeDay[] {
  const out: IntakeDay[] = [];
  for (let d = days; d >= 1; d -= 1) {
    const good = days - d < qualified;
    out.push({ date: back(d), kcal: good ? kcal : 600, energyCoverage: good ? 1 : 0.4 });
  }
  return out;
}

const input = (over: Partial<ExpenditureInput> = {}): ExpenditureInput => ({
  asOf: AS_OF, weighIns: weighIns(40), intake: intake(40),
  priorKcal: PRIOR_KCAL, bmrKcal: BMR_KCAL, ...over,
});

describe("estimateExpenditure — burn-in", () => {
  it("returns burn_in with no numbers before 21 qualified days", () => {
    const r = estimateExpenditure(input({ weighIns: weighIns(10), intake: intake(10) }));
    expect(r.status).toBe("burn_in");
    expect(r.tdeeKcal).toBeNull();
    expect(r.weightTrendKg).toBeNull();
    expect(r.reason).toBe("Learning your numbers — 10 of 21 days");
    expect(r.engineVersion).toBe(ENGINE_VERSION);
  });

  it("stays burn_in on a 60-day account with only 14 qualified days (acceptance criterion 2)", () => {
    const r = estimateExpenditure(input({ weighIns: weighIns(60), intake: intake(60, 14) }));
    expect(r.status).toBe("burn_in");
    expect(r.tdeeKcal).toBeNull();
  });

  it("stays burn_in with 21 qualified days but fewer than 15 in the last 21", () => {
    // 21 qualified days, all of them older than 21 days ago.
    const stale: IntakeDay[] = [];
    for (let d = 60; d >= 1; d -= 1) {
      const good = d > 25 && d <= 46;
      stale.push({ date: back(d), kcal: good ? 2100 : 600, energyCoverage: good ? 1 : 0.4 });
    }
    const r = estimateExpenditure(input({ weighIns: weighIns(60), intake: stale }));
    expect(r.status).toBe("burn_in");
  });

  it("stays burn_in with fewer than 12 weigh-ins in the last 21", () => {
    const sparse = weighIns(60).filter((w) => toDayNumber(AS_OF) - toDayNumber(w.date) > 21
      || (toDayNumber(AS_OF) - toDayNumber(w.date)) % 3 === 0);
    const r = estimateExpenditure(input({ weighIns: sparse }));
    expect(r.status).toBe("burn_in");
  });
});

describe("estimateExpenditure — held", () => {
  it("holds with 3 qualified days in the last 7 and never lowers the TDEE", () => {
    const sparse: IntakeDay[] = intake(40).map((day) => {
      const age = toDayNumber(AS_OF) - toDayNumber(day.date);
      return age <= 7 && age % 2 === 0 ? { ...day, kcal: 600, energyCoverage: 0.4 } : day;
    });
    const r = estimateExpenditure(input({ intake: sparse }));
    expect(r.status).toBe("held");
    expect(r.tdeeKcal).toBe(PRIOR_KCAL);
    expect(r.reason).toBe("3 qualified days in the last 7");
  });

  it("holds with fewer than 3 weigh-ins in the last 7", () => {
    const r = estimateExpenditure(input({ weighIns: weighIns(40, undefined, [1, 2, 3, 4, 5]) }));
    expect(r.status).toBe("held");
    expect(r.reason).toBe("2 weigh-ins in the last 7");
  });
});

describe("estimateExpenditure — estimating", () => {
  it("reports a rounded TDEE, the trend and the completeness fractions", () => {
    const r = estimateExpenditure(input());
    expect(r.status).toBe("estimating");
    expect(r.tdeeKcal).not.toBeNull();
    expect((r.tdeeKcal as number) % 10).toBe(0);
    expect(r.weightTrendKg).toBeCloseTo(57.3, 1);
    expect(r.intakeCompleteness).toBe(1);
    expect(r.weighInCompleteness).toBe(1);
    expect(r.qualifiedDays).toBe(21);
    expect(r.weighInCount).toBe(21);
    expect(r.confidence).toBeCloseTo(1, 10);
    expect(r.reason).toBeNull();
  });

  it("reads the prior back: a run seeded with its own output returns the same number", () => {
    const first = estimateExpenditure(input());
    const second = estimateExpenditure(input({ priorKcal: first.tdeeKcal as number }));
    expect(second.tdeeKcal).toBe(first.tdeeKcal);
  });

  it("clamps a wild intake to prior + 10 % and then to the BMR bound", () => {
    const huge = estimateExpenditure(input({ intake: intake(40, 40, 6000) }));
    expect(huge.tdeeKcal).toBe(2340);         // 2130 × 1.1 = 2343 → round 10
    const low = estimateExpenditure(input({ intake: intake(40, 40, 1200), priorKcal: 1300 }));
    expect(low.tdeeKcal as number).toBeGreaterThanOrEqual(1235);
  });
});

describe("blockedFrom", () => {
  it("keeps every number and swaps the status and the reason", () => {
    const r = estimateExpenditure(input());
    const b = blockedFrom(r, "Fat floor needs +210 kcal, above the 150 kcal weekly step");
    expect(b.status).toBe("blocked");
    expect(b.reason).toBe("Fat floor needs +210 kcal, above the 150 kcal weekly step");
    expect(b.tdeeKcal).toBe(r.tdeeKcal);
    expect(b.confidence).toBe(r.confidence);
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/expenditure.test.ts` — expect `estimateExpenditure is not a function`.
- [ ] Append to `lib/expenditure.ts`:

```ts
function ageInDays(date: string, asOf: string): number {
  return toDayNumber(asOf) - toDayNumber(date);
}

/** "the last N days" always means an age in [1, N]: today is never counted. */
function withinLast(date: string, asOf: string, days: number): boolean {
  const age = ageInDays(date, asOf);
  return age >= 1 && age <= days;
}

/**
 * The §4.3 state machine and clamp order.
 *
 * The three burn-in counts read different windows, because each one asks a different question:
 *   ≥ BURN_IN_QUALIFIED qualified days — LIFETIME, so elapsed calendar time alone never ends
 *     burn-in (§4.3, acceptance criterion 2);
 *   ≥ BURN_IN_WEIGH_INS weighed days in the last 21 — enough scale data to trust the trend;
 *   ≥ BURN_IN_COMPLETE qualified days in the last 21 — recent density, not an old good patch.
 * `qualifiedDays` and `weighInCount` in the result are the last-21 counts the API type names.
 */
export function estimateExpenditure(input: ExpenditureInput): ExpenditureResult {
  const { asOf, weighIns, intake, priorKcal, bmrKcal } = input;

  const qualified = intake.filter((day) => isQualifiedDay(day, asOf));
  const qualifiedTotal = qualified.length;
  const qualified21 = qualified.filter((d) => withinLast(d.date, asOf, BURN_IN_QUALIFIED)).length;
  const qualified14 = qualified.filter((d) => withinLast(d.date, asOf, WINDOW_DAYS));
  const qualified7 = qualified.filter((d) => withinLast(d.date, asOf, RECENT_DAYS)).length;

  const weighDays = [...new Set(weighIns.map((w) => w.date))];
  const weighIn21 = weighDays.filter((d) => withinLast(d, asOf, BURN_IN_QUALIFIED)).length;
  const weighIn14 = weighDays.filter((d) => withinLast(d, asOf, WINDOW_DAYS)).length;
  const weighIn7 = weighDays.filter((d) => withinLast(d, asOf, RECENT_DAYS)).length;

  const intakeCompleteness = Math.min(qualified14.length / WINDOW_DAYS, 1);
  const weighInCompleteness = Math.min(weighIn14 / WINDOW_DAYS, 1);
  const confidence = confidenceFor(intakeCompleteness, weighInCompleteness, qualified21);
  const intakeAvgKcal = qualified14.length === 0
    ? null
    : qualified14.reduce((sum, d) => sum + d.kcal, 0) / qualified14.length;

  const trend = step1BuildTrend(weighIns, asOf);
  const endpoints = step2TrendEndpoints(trend);

  const base = {
    intakeAvgKcal, intakeCompleteness, weighInCompleteness,
    qualifiedDays: qualified21, weighInCount: weighIn21, confidence,
    engineVersion: ENGINE_VERSION,
  };

  const burnIn = qualifiedTotal < BURN_IN_QUALIFIED
    || weighIn21 < BURN_IN_WEIGH_INS
    || qualified21 < BURN_IN_COMPLETE
    || endpoints.held;
  if (burnIn) {
    return { ...base, status: "burn_in", tdeeKcal: null, weightTrendKg: null,
      reason: `Learning your numbers — ${qualifiedTotal} of ${BURN_IN_QUALIFIED} days` };
  }

  // Past burn-in both endpoints are defined, so the trend is always shown from here on.
  const trendNow = endpoints.now as number;
  const trendThen = endpoints.then as number;

  if (qualified7 < HELD_QUALIFIED_7) {
    return { ...base, status: "held", tdeeKcal: step7Round(priorKcal), weightTrendKg: trendNow,
      reason: `${qualified7} qualified days in the last ${RECENT_DAYS}` };
  }
  if (weighIn7 < HELD_WEIGH_INS_7) {
    return { ...base, status: "held", tdeeKcal: step7Round(priorKcal), weightTrendKg: trendNow,
      reason: `${weighIn7} weigh-ins in the last ${RECENT_DAYS}` };
  }

  const raw = step3TdeeRaw(intakeAvgKcal as number, trendNow, trendThen);
  const clamped = step4ClampToPrior(raw, priorKcal);
  const blended = step5Blend(clamped, priorKcal, confidence);
  const bounded = step6ClampToBmr(blended, bmrKcal);

  return { ...base, status: "estimating", tdeeKcal: step7Round(bounded),
    weightTrendKg: trendNow, reason: null };
}

/**
 * `blocked` is not an engine verdict: §4.3 defines it as "a proposal would need a calorie rise
 * above max_weekly_kcal_step to satisfy a floor", which only the weekly job knows. The job calls
 * this to stamp the estimate it is about to store; every measured number is preserved.
 */
export function blockedFrom(result: ExpenditureResult, reason: string): ExpenditureResult {
  return { ...result, status: "blocked", reason };
}
```

- [ ] Run: `pnpm test tests/expenditure/expenditure.test.ts` — expect PASS (10 tests).
- [ ] Run the whole engine suite once: `pnpm test tests/expenditure` — expect PASS.
- [ ] Commit: `git add lib/expenditure.ts tests/expenditure && git commit -m "feat(expenditure): status machine and estimateExpenditure"`

---

## Task 6 — Deterministic fixtures and the scenario replay harness

**Files**
- Create: `lib/expenditure.fixtures.ts`
- Test: `tests/expenditure/fixtures.test.ts`

**Interfaces**
- Consumes: `KCAL_PER_KG`, `PRIOR_KCAL`, `BMR_KCAL`, `fromDayNumber`, `toDayNumber`, `estimateExpenditure`, `type WeighIn`, `type IntakeDay`, `type ExpenditureResult`.
- Produces: `LCG_A`, `LCG_C`, `LCG_M`, `START_DATE`, `BASE_KG`, `BASE_TDEE`, `NOISE_KG`, `NOISE_KCAL`, `SCENARIO_DAYS`; `lcg(seed: number): () => number`; `type Scenario = { label: string; asOf: string; weighIns: WeighIn[]; intake: IntakeDay[] }`; `buildScenario(args)`; `steadyState()`, `waterSwing()`, `cycleSwing()`, `trainingStep()`, `rampUp()`, `underLogging()`; `SCENARIOS: readonly Scenario[]`; `replayScenario(scenario, opts?): { date: string; result: ExpenditureResult }[]`.

- [ ] Write the failing test `tests/expenditure/fixtures.test.ts`:

```ts
// tests/expenditure/fixtures.test.ts
import { describe, expect, it } from "vitest";
import { BASE_KG, lcg, replayScenario, SCENARIOS, steadyState, waterSwing } from "@/lib/expenditure.fixtures";

describe("lcg", () => {
  it("is deterministic and stays in [0,1)", () => {
    const a = Array.from({ length: 5 }, lcg(42));
    expect(Array.from({ length: 5 }, lcg(42))).toEqual(a);
    const draws = Array.from({ length: 500 }, () => lcg(7)()).map(() => 0);
    expect(draws.every((v) => v >= 0 && v < 1)).toBe(true);
    const stream = lcg(7);
    for (let i = 0; i < 500; i += 1) {
      const v = stream();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("never uses Math.random", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("lib/expenditure.fixtures.ts", "utf8"));
    expect(src).not.toContain("Math.random");
  });
});

describe("scenarios", () => {
  it("ships the six F-092 series, each with a label and a full 90-day span", () => {
    expect(SCENARIOS.map((s) => s.label)).toEqual([
      "steady state", "1.5 kg water swing over 3 days", "±0.8 kg on a 28-day cycle",
      "+250 kcal/day step", "+15 kcal/day/week ramp", "under-logging: 3 qualified days a week",
    ]);
    for (const s of SCENARIOS) expect(s.intake.length).toBeGreaterThanOrEqual(90);
  });

  it("is byte-identical on a second build", () => {
    expect(JSON.stringify(steadyState())).toBe(JSON.stringify(steadyState()));
  });

  it("keeps the water swing's peak day above the 2.5 % outlier bound", () => {
    const peak = waterSwing().weighIns.reduce((max, w) => Math.max(max, w.kg), 0);
    expect(peak - BASE_KG).toBeCloseTo(1.5, 1);
  });

  it("replays day by day and carries the prior forward", () => {
    const runs = replayScenario(steadyState());
    expect(runs.length).toBeGreaterThan(60);
    expect(runs.at(-1)?.result.status).toBe("estimating");
    expect(runs[0].result.status).toBe("burn_in");
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/fixtures.test.ts` — expect `Failed to resolve import "@/lib/expenditure.fixtures"`.
- [ ] Write `lib/expenditure.fixtures.ts`:

```ts
/**
 * Deterministic synthetic series for the §4.3 acceptance backtests and
 * `scripts/backtest-estimator.ts`. No `Math.random`: noise comes from a seeded linear congruential
 * generator, so a scenario is byte-identical on every machine and in CI.
 *
 * Anchors from `../analysis/targets.md`: BASE_KG 57.6 kg is §2's "She is 127 lb"; BASE_TDEE 2130 is
 * §1's working number. Weight moves only through the energy balance, at the §4.3 approximation of
 * 7700 kcal/kg, plus whatever artefact the scenario adds on top.
 */
import {
  BMR_KCAL, estimateExpenditure, fromDayNumber, KCAL_PER_KG, PRIOR_KCAL, toDayNumber,
  type ExpenditureResult, type IntakeDay, type WeighIn,
} from "@/lib/expenditure";

/** Numerical Recipes' 32-bit LCG. */
export const LCG_A = 1_664_525;
export const LCG_C = 1_013_904_223;
export const LCG_M = 2 ** 32;

export const START_DATE = "2026-06-01";
export const SCENARIO_DAYS = 120;
export const BASE_KG = 57.6;
export const BASE_TDEE = 2130;
/** Scale noise, one standard step. Real bathroom scales are worse; this is enough to test the EMA. */
export const NOISE_KG = 0.25;
/** Logging noise on a qualified day. */
export const NOISE_KCAL = 120;

export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, LCG_A) + LCG_C) >>> 0;
    return state / LCG_M;
  };
}

export type Scenario = { label: string; asOf: string; weighIns: WeighIn[]; intake: IntakeDay[] };

export type ScenarioArgs = {
  label: string; seed: number; days?: number;
  /** True expenditure on day `d` (0-based from START_DATE). */
  tdee: (d: number) => number;
  /** What she actually ate on day `d`. */
  intake: (d: number) => number;
  /** Artefact added to the SCALE reading on day `d` (water, cycle) — not real tissue. */
  artefactKg?: (d: number) => number;
  /** Whether day `d` is fully logged (a qualified day). */
  logged?: (d: number) => boolean;
  /** Whether she stepped on the scale on day `d`. */
  weighed?: (d: number) => boolean;
};

export function buildScenario(args: ScenarioArgs): Scenario {
  const days = args.days ?? SCENARIO_DAYS;
  const noise = lcg(args.seed);
  const logged = args.logged ?? (() => true);
  const weighed = args.weighed ?? (() => true);
  const artefact = args.artefactKg ?? (() => 0);

  const weighIns: WeighIn[] = [];
  const intake: IntakeDay[] = [];
  let trueKg = BASE_KG;

  for (let d = 0; d < days; d += 1) {
    const date = fromDayNumber(toDayNumber(START_DATE) + d);
    const eaten = args.intake(d);
    const fed = logged(d);
    intake.push(fed
      ? { date, kcal: Math.round(eaten + (noise() - 0.5) * 2 * NOISE_KCAL), energyCoverage: 1 }
      : { date, kcal: Math.round(eaten * 0.35), energyCoverage: 0.5 });
    if (weighed(d)) {
      const reading = trueKg + artefact(d) + (noise() - 0.5) * 2 * NOISE_KG;
      weighIns.push({ date, kg: Math.round(reading * 1000) / 1000 });
    }
    trueKg += (eaten - args.tdee(d)) / KCAL_PER_KG;
  }

  return { label: args.label, asOf: fromDayNumber(toDayNumber(START_DATE) + days), weighIns, intake };
}

export function steadyState(): Scenario {
  return buildScenario({ label: "steady state", seed: 1001,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE });
}

/** §4.3 claim 1a. +0.5, +1.5, +0.5 kg on three consecutive days, then gone. The 1.5 kg day is
 *  2.6 % of BASE_KG, so the outlier rule holds it out — that is the mechanism under test. */
export function waterSwing(): Scenario {
  const swing = [0.5, 1.5, 0.5];
  return buildScenario({ label: "1.5 kg water swing over 3 days", seed: 1002,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE,
    artefactKg: (d) => (d >= 70 && d < 73 ? swing[d - 70] : 0) });
}

/** §4.3 claim 1b. ±0.8 kg fluid on a 28-day period; the daily step stays under the outlier bound. */
export function cycleSwing(): Scenario {
  return buildScenario({ label: "±0.8 kg on a 28-day cycle", seed: 1003,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE,
    artefactKg: (d) => 0.8 * Math.sin((2 * Math.PI * d) / 28) });
}

/** §4.3 claim 3a. The training start: true expenditure steps +250 kcal/day, intake does not move. */
export function trainingStep(): Scenario {
  return buildScenario({ label: "+250 kcal/day step", seed: 1004,
    tdee: (d) => BASE_TDEE + (d >= 60 ? 250 : 0), intake: () => BASE_TDEE });
}

/** §4.3 claim 3b. A +15 kcal/day/week ramp, i.e. 15/7 kcal per day per day. */
export function rampUp(): Scenario {
  return buildScenario({ label: "+15 kcal/day/week ramp", seed: 1005,
    tdee: (d) => BASE_TDEE + (d >= 60 ? ((d - 60) * 15) / 7 : 0), intake: () => BASE_TDEE });
}

/** §4.3 claim 2. From day 80 she logs three days a week. */
export function underLogging(): Scenario {
  return buildScenario({ label: "under-logging: 3 qualified days a week", seed: 1006,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE,
    logged: (d) => d < 80 || d % 7 < 3 });
}

export const SCENARIOS: readonly Scenario[] = [
  steadyState(), waterSwing(), cycleSwing(), trainingStep(), rampUp(), underLogging(),
];

export type ReplayRun = { date: string; result: ExpenditureResult };

/**
 * Run the nightly job over the whole series, one day at a time, carrying the prior forward exactly
 * as clamp step 7 requires ("prior for the next run is this value"). A `burn_in` or `held` day
 * leaves the prior where it was, so under-logging cannot walk the number down.
 */
export function replayScenario(
  scenario: Scenario, opts: { priorKcal?: number; bmrKcal?: number; from?: number } = {},
): ReplayRun[] {
  let prior = opts.priorKcal ?? PRIOR_KCAL;
  const bmrKcal = opts.bmrKcal ?? BMR_KCAL;
  const first = opts.from ?? 21;
  const runs: ReplayRun[] = [];
  const end = toDayNumber(scenario.asOf);

  for (let day = toDayNumber(START_DATE) + first; day <= end; day += 1) {
    const asOf = fromDayNumber(day);
    const result = estimateExpenditure({ asOf, priorKcal: prior, bmrKcal,
      weighIns: scenario.weighIns.filter((w) => toDayNumber(w.date) < day),
      intake: scenario.intake.filter((i) => toDayNumber(i.date) < day) });
    if (result.status === "estimating" && result.tdeeKcal !== null) prior = result.tdeeKcal;
    runs.push({ date: asOf, result });
  }
  return runs;
}
```

- [ ] Run: `pnpm test tests/expenditure/fixtures.test.ts` — expect PASS (5 tests).
- [ ] Commit: `git add lib/expenditure.fixtures.ts tests/expenditure && git commit -m "feat(expenditure): seeded synthetic scenarios and the replay harness"`

---

## Task 7 — The three §4.3 backtests and the committed exit record

**Files**
- Create: `tests/expenditure/backtest.test.ts`
- Create: `scripts/backtest-estimator.ts`
- Create (generated, committed): `docs/estimator-backtest-<date>.md`

**Interfaces**
- Consumes: `SCENARIOS`, `replayScenario`, `steadyState`, `waterSwing`, `cycleSwing`, `trainingStep`, `rampUp`, `underLogging`, `BASE_TDEE`.
- Produces: `ARTEFACT_MAX_PCT = 0.05`, `STEP_MAX_KCAL = 100`, `STEP_WITHIN_DAYS = 21`, `RAMP_MAX_KCAL = 120` (exported from the test file for the script to re-use is **not** allowed — the script re-declares them from the same spec text and a test asserts the two agree).

> **Measured, never lowered.** These bounds are §4.3's words. If a run misses one, record the measured number in `docs/estimator-backtest-<date>.md`, attach it to the PR, and raise a contract question — do not tune a constant in `lib/expenditure.ts` to make the test green (Global Constraints; see Open questions 3).

- [ ] Write the failing test `tests/expenditure/backtest.test.ts`:

```ts
// tests/expenditure/backtest.test.ts
import { describe, expect, it } from "vitest";
import {
  cycleSwing, rampUp, replayScenario, steadyState, trainingStep, underLogging, waterSwing,
  BASE_TDEE, toScenarioDay,
} from "@/lib/expenditure.fixtures";

/** §4.3's three acceptance claims, at their stated bounds. */
export const ARTEFACT_MAX_PCT = 0.05;
export const STEP_MAX_KCAL = 100;
export const STEP_WITHIN_DAYS = 21;
export const RAMP_MAX_KCAL = 120;

const control = replayScenario(steadyState());
const tdeeOn = (runs: ReturnType<typeof replayScenario>, date: string) =>
  runs.find((r) => r.date === date)?.result ?? null;

function maxDeviationPct(runs: ReturnType<typeof replayScenario>): number {
  let worst = 0;
  for (const run of runs) {
    const base = tdeeOn(control, run.date);
    if (!base?.tdeeKcal || !run.result.tdeeKcal) continue;
    worst = Math.max(worst, Math.abs(run.result.tdeeKcal - base.tdeeKcal) / base.tdeeKcal);
  }
  return worst;
}

function statusesMatchControl(runs: ReturnType<typeof replayScenario>): boolean {
  return runs.every((run) => tdeeOn(control, run.date)?.status === run.result.status);
}

describe("claim 1 — artefacts stay bounded", () => {
  it("a 1.5 kg water swing over 3 days moves TDEE by at most 5 % and changes no status", () => {
    const runs = replayScenario(waterSwing());
    expect(maxDeviationPct(runs)).toBeLessThanOrEqual(ARTEFACT_MAX_PCT);
    expect(statusesMatchControl(runs)).toBe(true);
  });

  it("a ±0.8 kg 28-day cycle moves TDEE by at most 5 % and changes no status", () => {
    const runs = replayScenario(cycleSwing());
    expect(maxDeviationPct(runs)).toBeLessThanOrEqual(ARTEFACT_MAX_PCT);
    expect(statusesMatchControl(runs)).toBe(true);
  });
});

describe("claim 2 — under-logging holds, it does not chase", () => {
  it("3 qualified days in a week produces held, with no lowered TDEE", () => {
    const runs = replayScenario(underLogging());
    const after = runs.filter((r) => toScenarioDay(r.date) >= 90);
    expect(after.every((r) => r.result.status === "held")).toBe(true);
    const before = runs.filter((r) => toScenarioDay(r.date) < 80 && r.result.tdeeKcal !== null);
    const lastGood = before.at(-1)?.result.tdeeKcal as number;
    expect(after.every((r) => (r.result.tdeeKcal as number) >= lastGood)).toBe(true);
  });
});

describe("claim 3 — real change is detected, with a stated lag", () => {
  it("a +250 kcal/day step lands within ±100 kcal inside 21 days", () => {
    const runs = replayScenario(trainingStep());
    const at21 = runs.find((r) => toScenarioDay(r.date) === 60 + STEP_WITHIN_DAYS);
    expect(at21?.result.status).toBe("estimating");
    expect(Math.abs((at21?.result.tdeeKcal as number) - (BASE_TDEE + 250)))
      .toBeLessThanOrEqual(STEP_MAX_KCAL);
  });

  it("a +15 kcal/day/week ramp is tracked with an error under 120 kcal", () => {
    const runs = replayScenario(rampUp());
    for (const run of runs) {
      const day = toScenarioDay(run.date);
      if (day < 60 + STEP_WITHIN_DAYS || run.result.tdeeKcal === null) continue;
      const truth = BASE_TDEE + ((day - 60) * 15) / 7;
      expect(Math.abs(run.result.tdeeKcal - truth)).toBeLessThan(RAMP_MAX_KCAL);
    }
  });
});
```

- [ ] Add the one missing helper to `lib/expenditure.fixtures.ts` (the test needs a day index):

```ts
/** Scenario day index (0-based from START_DATE) for a replay date. */
export function toScenarioDay(date: string): number {
  return toDayNumber(date) - toDayNumber(START_DATE);
}
```

- [ ] Run: `pnpm test tests/expenditure/backtest.test.ts` — expect `toScenarioDay is not exported` on the first run, then the five real assertions.
- [ ] Write `scripts/backtest-estimator.ts`:

```ts
/**
 * Replays every synthetic scenario through the engine and writes the exit record for Phase 6
 * acceptance criterion 4. Run: `pnpm exec tsx scripts/backtest-estimator.ts`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { BASE_TDEE, replayScenario, SCENARIOS, steadyState, toScenarioDay } from "@/lib/expenditure.fixtures";
import { ENGINE_VERSION } from "@/lib/expenditure";

const control = replayScenario(steadyState());

function row(label: string, runs: ReturnType<typeof replayScenario>) {
  let worstPct = 0;
  let worstKcal = 0;
  const statuses = new Set<string>();
  for (const run of runs) {
    statuses.add(run.result.status);
    const base = control.find((c) => c.date === run.date)?.result;
    if (!base?.tdeeKcal || !run.result.tdeeKcal) continue;
    worstPct = Math.max(worstPct, Math.abs(run.result.tdeeKcal - base.tdeeKcal) / base.tdeeKcal);
    worstKcal = Math.max(worstKcal, Math.abs(run.result.tdeeKcal - base.tdeeKcal));
  }
  const last = runs.at(-1)?.result;
  return `| ${label} | ${last?.status ?? "—"} | ${last?.tdeeKcal ?? "—"} | ${last?.confidence.toFixed(2) ?? "—"} | ${(worstPct * 100).toFixed(1)} % | ${Math.round(worstKcal)} | ${[...statuses].sort().join(", ")} |`;
}

const today = new Date().toISOString().slice(0, 10);
const lines = [
  `# Estimator backtest — ${today}`,
  "",
  `Engine \`${ENGINE_VERSION}\`, seeds prior ${BASE_TDEE} kcal / BMR 1372 kcal (targets.md §1).`,
  "Every series is generated by the seeded LCG in `lib/expenditure.fixtures.ts`; re-running this",
  "script on any machine reproduces the table byte for byte.",
  "",
  "| Scenario | Final status | Final TDEE | Confidence | Max deviation vs steady state | Max Δ kcal | Statuses seen |",
  "|---|---|---|---|---|---|---|",
  ...SCENARIOS.map((s) => row(s.label, replayScenario(s))),
  "",
  "## §4.3 acceptance claims",
  "",
  "1. Artefacts bounded — water swing and 28-day cycle: deviation column above, bound 5 %.",
  "2. Under-logging holds — the under-logging row's statuses must contain `held` and no run after",
  "   day 90 may report a TDEE below the last `estimating` value.",
  `3. Real change detected — the +250 kcal step must land within ±100 kcal of ${BASE_TDEE + 250} by`,
  "   day 81, and the ramp must stay under 120 kcal of truth.",
  "",
  "Measured by `tests/expenditure/backtest.test.ts`. A miss is recorded here and raised as a",
  "contract question; no constant is tuned to make a bound pass.",
  "",
];

mkdirSync("docs", { recursive: true });
writeFileSync(`docs/estimator-backtest-${today}.md`, `${lines.join("\n")}\n`, "utf8");
console.log(`wrote docs/estimator-backtest-${today}.md`);
console.log(lines.slice(6, 15).join("\n"));
```

- [ ] Run the script: `pnpm exec tsx scripts/backtest-estimator.ts` — expect `wrote docs/estimator-backtest-<today>.md` plus the table on stdout.
- [ ] Run: `pnpm test tests/expenditure/backtest.test.ts` — expect PASS (5 tests). If a bound is missed, stop and follow the "Measured, never lowered" note above.
- [ ] Commit: `git add tests/expenditure scripts/backtest-estimator.ts lib/expenditure.fixtures.ts docs/estimator-backtest-*.md && git commit -m "test(expenditure): the three §4.3 acceptance backtests and the exit record"`

---

## Task 8 — Wire types and percent target mode

**Files**
- Create: `lib/api-types.ts`
- Create: `lib/targets/percent.ts`
- Test: `tests/targets/percent.test.ts`

**Interfaces**
- Consumes: `RAMP_TABLE` (`lib/targets.ts:26`), `type Macros`, `type RampStage` (`lib/types.ts:27`), `rampStageFor(firstOpenedAt, date, rampOverride)` (`lib/plan.ts:66`), `type ExpenditureStatus` (`lib/expenditure.ts`).
- Produces (`lib/api-types.ts`): `ExpenditureResponse`, `ProposalSummary`, `ProposedTargets`, `DecideRequest`, `DecideResponse`, `TargetsRequest`, `TargetsResponse`, `JobResponse`, `TargetProfile`.
- Produces (`lib/targets/percent.ts`): `KCAL_MIN`, `FAT_G_MIN`, `CARB_G_MIN`, `KCAL_PER_G_PROTEIN`, `KCAL_PER_G_FAT`, `KCAL_PER_G_CARB`, `PCT_SUM`, `PCT_DECIMALS`; `type MacroPercents`, `type GramTargets`, `type MacroFloors`; `percentToGrams`, `applyFloors`, `validatePercentProfile`, `proteinFloorForStage`, `resolveProfileMacros`.

- [ ] Write the failing test `tests/targets/percent.test.ts`:

```ts
// tests/targets/percent.test.ts
import { describe, expect, it } from "vitest";
import {
  applyFloors, CARB_G_MIN, FAT_G_MIN, KCAL_MIN, percentToGrams, proteinFloorForStage,
  resolveProfileMacros, validatePercentProfile, type MacroFloors,
} from "@/lib/targets/percent";
import { RAMP_TABLE } from "@/lib/targets";

const FLOORS: MacroFloors = { kcalMin: KCAL_MIN, proteinGMin: 135, fatGMin: FAT_G_MIN, carbGMin: CARB_G_MIN };

describe("floors come from targets.md, not from thin air", () => {
  it("uses 1650 kcal, 50 g fat, 0 g carbs and the ramp's protein", () => {
    expect([KCAL_MIN, FAT_G_MIN, CARB_G_MIN]).toEqual([1650, 50, 0]);
    expect(proteinFloorForStage(1)).toBe(115);
    expect(proteinFloorForStage(2)).toBe(125);
    expect(proteinFloorForStage(3)).toBe(135);
  });
  it("reads the same protein on both day types, as the ramp table authors it", () => {
    for (const stage of [1, 2, 3] as const) {
      expect(RAMP_TABLE[stage].training.protein).toBe(RAMP_TABLE[stage].rest.protein);
    }
  });
});

describe("percentToGrams", () => {
  it("converts at both day types and reconstructs the calories within ±10", () => {
    for (const kcal of [2200, 1750]) {
      const g = percentToGrams(kcal, { proteinPct: 25, fatPct: 35, carbPct: 40 });
      expect(Math.abs(4 * g.proteinG + 9 * g.fatG + 4 * g.carbG - kcal)).toBeLessThanOrEqual(10);
    }
  });
  it("gives carbs the remainder so protein and fat round cleanly", () => {
    const g = percentToGrams(2200, { proteinPct: 25, fatPct: 35, carbPct: 40 });
    expect(g.proteinG).toBe(138);
    expect(g.fatG).toBe(86);
    expect(g.carbG).toBe(220);
  });
});

describe("applyFloors — architecture §3.4 steps 1 to 6, in order", () => {
  it("leaves a compliant set alone", () => {
    const out = applyFloors(2200, { proteinG: 138, fatG: 86, carbG: 220 }, FLOORS);
    expect(out.raisedToFloor).toBe(false);
    expect(out.kcal).toBe(2200);
  });
  it("raises protein and fat to their floors and lets carbs absorb the rest", () => {
    const out = applyFloors(2200, { proteinG: 100, fatG: 40, carbG: 360 }, FLOORS);
    expect(out.grams.proteinG).toBe(135);
    expect(out.grams.fatG).toBe(50);
    expect(out.grams.carbG).toBe(Math.round((2200 - 4 * 135 - 9 * 50) / 4));
    expect(out.raisedToFloor).toBe(false);
  });
  it("raises kcal rather than cutting protein or fat when the floors do not fit (step 5)", () => {
    const out = applyFloors(1000, { proteinG: 60, fatG: 20, carbG: 60 }, FLOORS);
    expect(out.grams.proteinG).toBe(135);
    expect(out.grams.fatG).toBe(50);
    expect(out.kcal).toBe(4 * 135 + 9 * 50 + 4 * CARB_G_MIN);
    expect(out.raisedToFloor).toBe(true);
  });
  it("never returns kcal below kcal_min (step 6)", () => {
    const out = applyFloors(1200, { proteinG: 135, fatG: 50, carbG: 0 }, FLOORS);
    expect(out.kcal).toBeGreaterThanOrEqual(KCAL_MIN);
  });
});

describe("validatePercentProfile", () => {
  it("accepts a split that clears both floors at both day types", () => {
    expect(validatePercentProfile({ proteinPct: 31, fatPct: 30, carbPct: 39 }, 2200, 1750, FLOORS))
      .toEqual({ ok: true });
  });
  it("rejects a sum that is not 100 after two decimals", () => {
    const r = validatePercentProfile({ proteinPct: 30, fatPct: 30, carbPct: 39 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({ ok: false, error: "percent_sum" });
  });
  it("rejects protein under its floor and names the minimum percentage", () => {
    const r = validatePercentProfile({ proteinPct: 20, fatPct: 30, carbPct: 50 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({ ok: false, error: "protein_below_floor" });
    if (r.ok) throw new Error("expected a rejection");
    expect(r.minProteinPct).toBeCloseTo(30.86, 2);            // 135 g × 4 ÷ 1750 × 100, rounded up
    expect(percentAt(r.minProteinPct, 1750) >= 135).toBe(true);
  });
  it("rejects fat under its floor and names the minimum percentage", () => {
    const r = validatePercentProfile({ proteinPct: 40, fatPct: 20, carbPct: 40 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({ ok: false, error: "fat_below_floor" });
    if (r.ok) throw new Error("expected a rejection");
    expect(r.minFatPct).toBeCloseTo(25.72, 2);                // 50 g × 9 ÷ 1750 × 100, rounded up
  });
});

const percentAt = (pct: number, kcal: number) => (kcal * pct) / 100 / 4;

describe("resolveProfileMacros", () => {
  it("holds protein and fat across day types and lets carbs carry the difference", () => {
    const out = resolveProfileMacros(
      { kcalTrain: 2200, kcalRest: 1750, proteinG: 135, fatG: 85, carbG: 200 }, FLOORS);
    expect(out.training.protein).toBe(135);
    expect(out.rest.protein).toBe(135);
    expect(out.rest.carbs).toBeLessThan(out.training.carbs);
    expect(out.rest.kcal).toBeGreaterThanOrEqual(KCAL_MIN);
  });
});
```

- [ ] Run: `pnpm test tests/targets/percent.test.ts` — expect `Failed to resolve import "@/lib/targets/percent"`.
- [ ] Write `lib/api-types.ts`:

```ts
/** Phase 6 wire types — `docs/specs/phase-6-estimator.md` "API changes", verbatim, plus the
 *  `target_profiles` row shape and the `ProposedTargets` alias the contracts name. */
import type { Macros } from "@/lib/types";

export type ExpenditureResponse = {
  status: "burn_in" | "held" | "estimating" | "blocked";
  localDate: string;
  tdeeKcal: number | null;          // null in burn_in
  weightTrendKg: number | null;     // null until status leaves burn_in
  confidence: number;               // 0..1
  intakeCompleteness: number;       // qualified days ÷ 14
  qualifiedDays: number;            // last 21
  weighInCount: number;             // last 21
  reason: string | null;            // "3 qualified days in the last 7"
  engineVersion: string;
};

export type ProposedTargets = {
  kcalTrain: number; kcalRest: number;
  proteinG: number; fatG: number; carbG: number;
  deltaKcalTrain: number; deltaKcalRest: number;
  raisedToFloor: boolean;           // §3.4 step 5 fired
};

export type ProposalSummary = {
  id: string; weekStart: string; createdAt: string;
  status: "pending" | "approved" | "rejected";
  basedOnEstimateId: string | null;
  proposed: ProposedTargets;
};

export type DecideRequest = { decision: "approve" | "reject"; expectedStatus: "pending" };
export type DecideResponse = { status: "approved" | "rejected"; targetProfileId: string | null };

export type TargetsRequest = {
  mode: "grams" | "percent"; effectiveFrom: string;
  kcalTrain: number; kcalRest: number;
  grams?: { proteinG: number; fatG: number; carbG: number };
  percent?: { proteinPct: number; fatPct: number; carbPct: number };
  goalRateBpWeek?: number; maxWeeklyKcalStep?: number;
};

export type TargetsResponse = {
  id: string; mode: "grams" | "percent";
  resolved: { training: Macros; rest: Macros }; raisedToFloor: boolean;
};

export type JobResponse = { ran: number; skipped: number; errors: number };

/** The `target_profiles` row exactly as architecture §3.4's DDL creates it. */
export type TargetProfile = {
  id: string; user_id: string; effective_from: string; rev: number;
  kcal_train: number; kcal_rest: number;
  authored_by: "coach" | "engine_proposal" | "user";
  mode: "grams" | "percent";
  protein_g: number | null; fat_g: number | null; carb_g: number | null;
  protein_pct: number | null; fat_pct: number | null; carb_pct: number | null;
  kcal_min: number; protein_g_min: number; fat_g_min: number; carb_g_min: number;
  goal_rate_bp_week: number; max_weekly_kcal_step: number;
  notes: string | null;
};
```

- [ ] Write `lib/targets/percent.ts`:

```ts
/**
 * Percent target mode and the floor sequence — architecture §3.4, transcribed. One module, used by
 * the sheet for the live preview and by `POST /api/targets` for authority; the client copy is for
 * display, never for authority (spec "Security").
 *
 * Floors come from `../analysis/targets.md`: fat 50 g ("Floor is 50 g — below that, female
 * hormonal function suffers", §3), kcal_min 1650 (the lowest authored day in §3's ramp, rest-day
 * week 1), carbs 0, and protein pinned to the ACTIVE ramp stage's value (§3's ramp: 115 / 125 /
 * 135 g). The active stage is read the same way the Today screen reads it:
 * `rampStageFor(user_settings.first_opened_at, today, user_settings.ramp_override)` from
 * `lib/plan.ts`, so a Devin override in Settings moves the protein floor with it.
 */
import { RAMP_TABLE } from "@/lib/targets";
import type { Macros, RampStage } from "@/lib/types";

export const KCAL_MIN = 1650;
export const FAT_G_MIN = 50;
export const CARB_G_MIN = 0;
export const KCAL_PER_G_PROTEIN = 4;
export const KCAL_PER_G_FAT = 9;
export const KCAL_PER_G_CARB = 4;
export const PCT_SUM = 100;
export const PCT_DECIMALS = 2;

export type MacroPercents = { proteinPct: number; fatPct: number; carbPct: number };
export type GramTargets = { proteinG: number; fatG: number; carbG: number };
export type MacroFloors = { kcalMin: number; proteinGMin: number; fatGMin: number; carbGMin: number };

/** targets.md §3 "The ramp" — protein is identical on training and rest days at every stage. */
export function proteinFloorForStage(stage: RampStage): number {
  return RAMP_TABLE[stage].training.protein;
}

const round2 = (n: number) => Math.round(n * 10 ** PCT_DECIMALS) / 10 ** PCT_DECIMALS;
const ceil2 = (n: number) => Math.ceil(n * 10 ** PCT_DECIMALS) / 10 ** PCT_DECIMALS;

/** §3.4: grams = kcal × pct ÷ 100 ÷ factor; protein and fat to the nearest gram, carbs the
 *  remainder, so the set reconstructs the calorie target within ±10 kcal. */
export function percentToGrams(kcal: number, pct: MacroPercents): GramTargets {
  const proteinG = Math.round((kcal * pct.proteinPct) / 100 / KCAL_PER_G_PROTEIN);
  const fatG = Math.round((kcal * pct.fatPct) / 100 / KCAL_PER_G_FAT);
  const carbG = Math.round(
    (kcal - KCAL_PER_G_PROTEIN * proteinG - KCAL_PER_G_FAT * fatG) / KCAL_PER_G_CARB);
  return { proteinG, fatG, carbG };
}

/**
 * §3.4's six numbered steps, in this order and no other:
 * (1) protein to its floor; (2) fat to its floor; (3) carbs are the floored remainder;
 * (4) kcal_required; (5) if it exceeds the day's calories, RAISE the calories — never cut protein
 * or fat to fit a number; (6) kcal is at least kcal_min.
 * `raisedToFloor` reports step 5 only, which is what `ProposedTargets.raisedToFloor` means.
 */
export function applyFloors(
  kcal: number, grams: GramTargets, floors: MacroFloors,
): { kcal: number; grams: GramTargets; raisedToFloor: boolean } {
  const proteinG = Math.max(grams.proteinG, floors.proteinGMin);
  const fatG = Math.max(grams.fatG, floors.fatGMin);
  const carbG = Math.max(floors.carbGMin, Math.round(
    (kcal - KCAL_PER_G_PROTEIN * proteinG - KCAL_PER_G_FAT * fatG) / KCAL_PER_G_CARB));
  const kcalRequired = KCAL_PER_G_PROTEIN * proteinG + KCAL_PER_G_FAT * fatG + KCAL_PER_G_CARB * carbG;
  const raisedToFloor = kcalRequired > kcal;
  const afterStep5 = raisedToFloor ? kcalRequired : kcal;
  return { kcal: Math.max(afterStep5, floors.kcalMin), grams: { proteinG, fatG, carbG }, raisedToFloor };
}

/** §3.4: reject when, at either day type, converted protein or fat falls below its floor; the
 *  error names the minimum percentage that satisfies it. The smaller day type binds. */
export function validatePercentProfile(
  pct: MacroPercents, kcalTrain: number, kcalRest: number, floors: MacroFloors,
): { ok: true } | { ok: false; error: string; minProteinPct: number; minFatPct: number } {
  const binding = Math.min(kcalTrain, kcalRest);
  const minProteinPct = ceil2((floors.proteinGMin * KCAL_PER_G_PROTEIN * 100) / binding);
  const minFatPct = ceil2((floors.fatGMin * KCAL_PER_G_FAT * 100) / binding);
  const reject = (error: string) => ({ ok: false as const, error, minProteinPct, minFatPct });

  if (round2(pct.proteinPct + pct.fatPct + pct.carbPct) !== PCT_SUM) return reject("percent_sum");
  for (const kcal of [kcalTrain, kcalRest]) {
    const grams = percentToGrams(kcal, pct);
    if (grams.proteinG < floors.proteinGMin) return reject("protein_below_floor");
    if (grams.fatG < floors.fatGMin) return reject("fat_below_floor");
  }
  return { ok: true };
}

/**
 * A stored profile carries ONE gram set plus two calorie numbers (§3.4's DDL), so protein and fat
 * are held across day types and carbohydrate carries the difference — the same shape the ramp uses
 * for protein. Each day type then runs the floor sequence on its own.
 */
export function resolveProfileMacros(
  profile: { kcalTrain: number; kcalRest: number; proteinG: number; fatG: number; carbG: number },
  floors: MacroFloors,
): { training: Macros; rest: Macros; raisedToFloor: boolean } {
  const day = (kcal: number, carbG: number): Macros & { raised: boolean } => {
    const out = applyFloors(kcal, { proteinG: profile.proteinG, fatG: profile.fatG, carbG }, floors);
    return { kcal: out.kcal, protein: out.grams.proteinG, carbs: out.grams.carbG,
      fat: out.grams.fatG, raised: out.raisedToFloor };
  };
  const training = day(profile.kcalTrain, profile.carbG);
  const restCarbs = Math.round(
    (profile.kcalRest - KCAL_PER_G_PROTEIN * profile.proteinG - KCAL_PER_G_FAT * profile.fatG)
    / KCAL_PER_G_CARB);
  const rest = day(profile.kcalRest, restCarbs);
  return {
    training: { kcal: training.kcal, protein: training.protein, carbs: training.carbs, fat: training.fat },
    rest: { kcal: rest.kcal, protein: rest.protein, carbs: rest.carbs, fat: rest.fat },
    raisedToFloor: training.raised || rest.raised,
  };
}
```

- [ ] Run: `pnpm test tests/targets/percent.test.ts` — expect PASS (12 tests).
- [ ] Commit: `git add lib/api-types.ts lib/targets tests/targets && git commit -m "feat(targets): percent mode, the §3.4 floor sequence and the Phase 6 wire types"`

---

## Task 9 — `buildProposal`

**Files**
- Create: `lib/proposal.ts`
- Test: `tests/proposals/build-proposal.test.ts`

**Interfaces**
- Consumes: `type ExpenditureResult`, `KCAL_PER_KG` (`lib/expenditure.ts`); `applyFloors`, `percentToGrams`, `FAT_G_MIN`, `KCAL_PER_G_PROTEIN`, `KCAL_PER_G_FAT`, `KCAL_PER_G_CARB` (`lib/targets/percent.ts`); `type TargetProfile`, `type ProposedTargets` (`lib/api-types.ts`).
- Produces: `TRAINING_DAYS_PER_WEEK = 4`, `REST_DAYS_PER_WEEK = 3`, `BP_PER_UNIT = 10000`, `DAYS_PER_WEEK = 7`; `buildProposal(args: { estimate: ExpenditureResult; active: TargetProfile }): { kind: "proposal"; proposed: ProposedTargets } | { kind: "blocked"; reason: string } | { kind: "none"; reason: string }`.

- [ ] Write the failing test `tests/proposals/build-proposal.test.ts`:

```ts
// tests/proposals/build-proposal.test.ts
import { describe, expect, it } from "vitest";
import { buildProposal } from "@/lib/proposal";
import { ENGINE_VERSION, type ExpenditureResult } from "@/lib/expenditure";
import type { TargetProfile } from "@/lib/api-types";

const estimate = (over: Partial<ExpenditureResult> = {}): ExpenditureResult => ({
  status: "estimating", tdeeKcal: 2200, weightTrendKg: 57.5, intakeAvgKcal: 2150,
  intakeCompleteness: 1, weighInCompleteness: 1, qualifiedDays: 21, weighInCount: 21,
  confidence: 1, reason: null, engineVersion: ENGINE_VERSION, ...over,
});

const active = (over: Partial<TargetProfile> = {}): TargetProfile => ({
  id: "p1", user_id: "u1", effective_from: "2026-09-01", rev: 1,
  kcal_train: 2200, kcal_rest: 1750, authored_by: "user", mode: "grams",
  protein_g: 135, fat_g: 85, carb_g: 200, protein_pct: null, fat_pct: null, carb_pct: null,
  kcal_min: 1650, protein_g_min: 135, fat_g_min: 50, carb_g_min: 0,
  goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null, ...over,
});

describe("buildProposal", () => {
  it("proposes nothing unless the estimate is estimating", () => {
    for (const status of ["burn_in", "held", "blocked"] as const) {
      expect(buildProposal({ estimate: estimate({ status }), active: active() }).kind).toBe("none");
    }
  });

  it("never moves protein from its authored value", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 2400 }), active: active() });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.proteinG).toBe(135);
  });

  it("keeps every calorie step inside max_weekly_kcal_step", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 3000 }), active: active() });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(Math.abs(out.proposed.deltaKcalTrain)).toBeLessThanOrEqual(150);
    expect(Math.abs(out.proposed.deltaKcalRest)).toBeLessThanOrEqual(150);
  });

  it("preserves the training / rest ratio", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 2250 }), active: active() });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.kcalTrain / out.proposed.kcalRest).toBeCloseTo(2200 / 1750, 2);
  });

  it("applies goal_rate_bp_week against the weight trend", () => {
    const flat = buildProposal({ estimate: estimate(), active: active() });
    const cutting = buildProposal({
      estimate: estimate(), active: active({ goal_rate_bp_week: -50 }) });
    if (flat.kind !== "proposal" || cutting.kind !== "proposal") throw new Error("expected proposals");
    expect(cutting.proposed.kcalTrain).toBeLessThan(flat.proposed.kcalTrain);
    // -50 bp/week of 57.5 kg = -0.2875 kg/week = -316 kcal/day
    expect(flat.proposed.kcalTrain - cutting.proposed.kcalTrain).toBeGreaterThan(100);
  });

  it("never puts fat below 50 g or the authored value, and never kcal below kcal_min", () => {
    const out = buildProposal({ estimate: estimate({ tdeeKcal: 1700 }), active: active({ fat_g: 40 }) });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.fatG).toBeGreaterThanOrEqual(50);
    expect(out.proposed.kcalRest).toBeGreaterThanOrEqual(1650);
  });

  it("blocks when a floor needs a rise above the step cap", () => {
    const out = buildProposal({
      estimate: estimate({ tdeeKcal: 1700 }),
      active: active({ kcal_train: 1700, kcal_rest: 1700, protein_g: 135, fat_g: 95,
        protein_g_min: 135, max_weekly_kcal_step: 20 }) });
    expect(out.kind).toBe("blocked");
    if (out.kind !== "blocked") throw new Error("expected blocked");
    expect(out.reason).toMatch(/floor/i);
  });

  it("resolves a percent profile through percentToGrams before proposing", () => {
    const out = buildProposal({ estimate: estimate(), active: active({
      mode: "percent", protein_g: null, fat_g: null, carb_g: null,
      protein_pct: 25, fat_pct: 35, carb_pct: 40 }) });
    if (out.kind !== "proposal") throw new Error(out.kind);
    expect(out.proposed.proteinG).toBeGreaterThanOrEqual(135);
  });
});
```

- [ ] Run: `pnpm test tests/proposals/build-proposal.test.ts` — expect `Failed to resolve import "@/lib/proposal"`.
- [ ] Write `lib/proposal.ts`:

```ts
/**
 * The Sunday proposal — architecture §4.3's proposal block, transcribed:
 *
 *   kcal = tdee + goal_rate_bp_week ÷ 10000 × weight_trend_kg × 7700 ÷ 7
 *   protein unchanged (authored, held across training and rest days)
 *   fat ≥ fat_g_min (50 g) and ≥ the authored value unless Devin lowers it
 *   carbs = the remainder; then the §3.4 floor sequence runs
 *   training / rest split preserved in the same ratio; |Δkcal| ≤ max_weekly_kcal_step
 *   kcal ≥ kcal_min and ≥ 4·protein_g_min + 9·fat_g_min
 *
 * Pure. It returns a proposal, a refusal, or silence; it never writes anything.
 */
import { KCAL_PER_KG, type ExpenditureResult } from "@/lib/expenditure";
import {
  applyFloors, KCAL_PER_G_CARB, KCAL_PER_G_FAT, KCAL_PER_G_PROTEIN, percentToGrams,
  type MacroFloors,
} from "@/lib/targets/percent";
import type { ProposedTargets, TargetProfile } from "@/lib/api-types";

/** targets.md header: "Training: Mon / Wed / Thu / Fri. Rest: Tue / Sat / Sun." */
export const TRAINING_DAYS_PER_WEEK = 4;
export const REST_DAYS_PER_WEEK = 3;
export const DAYS_PER_WEEK = TRAINING_DAYS_PER_WEEK + REST_DAYS_PER_WEEK;
/** `goal_rate_bp_week` is basis points of bodyweight per week: −50 = lose 0.5 %/week (§3.4). */
export const BP_PER_UNIT = 10_000;

export type BuildProposalResult =
  | { kind: "proposal"; proposed: ProposedTargets }
  | { kind: "blocked"; reason: string }
  | { kind: "none"; reason: string };

function floorsOf(active: TargetProfile): MacroFloors {
  return { kcalMin: active.kcal_min, proteinGMin: active.protein_g_min,
    fatGMin: active.fat_g_min, carbGMin: active.carb_g_min };
}

/** The gram set the profile authors today, at its own training-day calories. */
function authoredGrams(active: TargetProfile): { proteinG: number; fatG: number } {
  if (active.mode === "percent") {
    const g = percentToGrams(active.kcal_train, {
      proteinPct: Number(active.protein_pct), fatPct: Number(active.fat_pct),
      carbPct: Number(active.carb_pct) });
    return { proteinG: g.proteinG, fatG: g.fatG };
  }
  return { proteinG: Number(active.protein_g), fatG: Number(active.fat_g) };
}

const clampStep = (next: number, current: number, cap: number) =>
  Math.round(Math.min(current + cap, Math.max(current - cap, next)));

export function buildProposal(args: {
  estimate: ExpenditureResult; active: TargetProfile;
}): BuildProposalResult {
  const { estimate, active } = args;
  if (estimate.status !== "estimating" || estimate.tdeeKcal === null) {
    return { kind: "none", reason: estimate.reason ?? `status is ${estimate.status}` };
  }

  const trendKg = estimate.weightTrendKg ?? 0;
  const goalKcalPerDay =
    ((active.goal_rate_bp_week / BP_PER_UNIT) * trendKg * KCAL_PER_KG) / DAYS_PER_WEEK;
  const targetDailyAvg = estimate.tdeeKcal + goalKcalPerDay;

  const currentDailyAvg =
    (TRAINING_DAYS_PER_WEEK * active.kcal_train + REST_DAYS_PER_WEEK * active.kcal_rest)
    / DAYS_PER_WEEK;
  // Preserving the ratio means scaling both day types by one factor.
  const factor = currentDailyAvg === 0 ? 1 : targetDailyAvg / currentDailyAvg;
  const cap = active.max_weekly_kcal_step;
  const kcalTrainRaw = clampStep(active.kcal_train * factor, active.kcal_train, cap);
  const kcalRestRaw = clampStep(active.kcal_rest * factor, active.kcal_rest, cap);

  const authored = authoredGrams(active);
  const proteinG = authored.proteinG;                       // protein never moves
  const fatG = Math.max(authored.fatG, active.fat_g_min);   // fat holds its floor and its author

  const floors = floorsOf(active);
  const forDay = (kcal: number) => {
    const carbG = Math.round(
      (kcal - KCAL_PER_G_PROTEIN * proteinG - KCAL_PER_G_FAT * fatG) / KCAL_PER_G_CARB);
    return applyFloors(kcal, { proteinG, fatG, carbG }, floors);
  };

  const training = forDay(kcalTrainRaw);
  const rest = forDay(kcalRestRaw);
  const deltaKcalTrain = training.kcal - active.kcal_train;
  const deltaKcalRest = rest.kcal - active.kcal_rest;

  if (Math.abs(deltaKcalTrain) > cap || Math.abs(deltaKcalRest) > cap) {
    return { kind: "blocked", reason:
      `Holding the fat and protein floors needs ${Math.max(Math.abs(deltaKcalTrain), Math.abs(deltaKcalRest))} kcal, above the ${cap} kcal weekly step. Devin decides.` };
  }

  return { kind: "proposal", proposed: {
    kcalTrain: training.kcal, kcalRest: rest.kcal,
    proteinG: training.grams.proteinG, fatG: training.grams.fatG, carbG: training.grams.carbG,
    deltaKcalTrain, deltaKcalRest,
    raisedToFloor: training.raisedToFloor || rest.raisedToFloor,
  } };
}
```

- [ ] Run: `pnpm test tests/proposals/build-proposal.test.ts` — expect PASS (8 tests).
- [ ] Commit: `git add lib/proposal.ts tests/proposals && git commit -m "feat(proposal): weekly target proposal with frozen protein and the step cap"`

---

## Task 10 — `lib/server/targets.ts`

**Files**
- Create: `lib/server/targets.ts`
- Test: `tests/targets/server-targets.test.ts`

**Interfaces**
- Consumes: `HttpError` (`lib/server/auth.ts`); `rampStageFor` (`lib/plan.ts:66`); `RAMP_TABLE` (`lib/targets.ts:26`); `applyFloors`, `percentToGrams`, `proteinFloorForStage`, `resolveProfileMacros`, `validatePercentProfile`, `KCAL_MIN`, `FAT_G_MIN`, `CARB_G_MIN`; `type TargetProfile`, `type TargetsRequest`, `type TargetsResponse`.
- Produces: `class FloorViolationError extends HttpError { minProteinPct: number; minFatPct: number }`; `activeProfile(client, userId): Promise<TargetProfile | null>`; `floorsFor(client, userId): Promise<MacroFloors>`; `rampTargets(client, userId): Promise<TargetsResponse>`; `activeTargets(client, userId): Promise<TargetsResponse | null>`; `authorTargets(client, userId, req): Promise<TargetsResponse>`.

- [ ] Write the failing test `tests/targets/server-targets.test.ts`:

```ts
// tests/targets/server-targets.test.ts
import { describe, expect, it, vi } from "vitest";
import { activeTargets, authorTargets, floorsFor, FloorViolationError, rampTargets } from "@/lib/server/targets";
import type { TargetProfile } from "@/lib/api-types";

const PROFILE: TargetProfile = {
  id: "p1", user_id: "u1", effective_from: "2026-09-01", rev: 1, kcal_train: 2200, kcal_rest: 1750,
  authored_by: "user", mode: "grams", protein_g: 135, fat_g: 85, carb_g: 200,
  protein_pct: null, fat_pct: null, carb_pct: null, kcal_min: 1650, protein_g_min: 135,
  fat_g_min: 50, carb_g_min: 0, goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null,
};

/** The two reads `lib/server/targets.ts` makes: target_profiles and user_settings. */
function clientWith(profile: TargetProfile | null, settings = {
  first_opened_at: "2026-08-25T09:00:00.000Z", ramp_override: null as number | null,
}) {
  const insert = vi.fn().mockResolvedValue({ data: { ...PROFILE, id: "p2" }, error: null });
  const from = vi.fn((table: string) => {
    if (table === "user_settings") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: settings, error: null }) }) }) };
    }
    return {
      select: () => ({ eq: () => ({ lte: () => ({ order: () => ({ order: () => ({ limit: () => ({
        maybeSingle: async () => ({ data: profile, error: null }) }) }) }) }) }) }),
      insert: (row: unknown) => ({ select: () => ({ single: () => insert(row) }) }),
    };
  });
  return { client: { from } as never, insert };
}

describe("activeTargets", () => {
  it("returns null when no profile is effective yet, so the caller falls back to the ramp", async () => {
    const { client } = clientWith(null);
    await expect(activeTargets(client, "u1")).resolves.toBeNull();
  });
  it("resolves both day types with protein held and carbs carrying the difference", async () => {
    const { client } = clientWith(PROFILE);
    const out = await activeTargets(client, "u1");
    expect(out?.resolved.training).toEqual({ kcal: 2200, protein: 135, carbs: 204, fat: 85 });
    expect(out?.resolved.rest.protein).toBe(135);
    expect(out?.resolved.rest.carbs).toBeLessThan(204);
  });
});

describe("rampTargets", () => {
  it("returns the authored ramp stage as the target when no profile exists", async () => {
    const { client } = clientWith(null, { first_opened_at: "2026-08-25T09:00:00.000Z", ramp_override: null });
    const out = await rampTargets(client, "u1");
    expect(out.id).toBe("ramp");
    expect(out.mode).toBe("grams");
    expect(out.resolved.training.protein).toBe(135);   // 17 days in → stage 3
  });
  it("honours a ramp override when Devin has pinned a stage", async () => {
    const { client } = clientWith(null, { first_opened_at: "2026-09-10T09:00:00.000Z", ramp_override: 1 });
    expect((await rampTargets(client, "u1")).resolved.training.protein).toBe(115);
  });
});

describe("floorsFor", () => {
  it("takes the protein floor from the active ramp stage and the rest from targets.md", async () => {
    const { client } = clientWith(null, { first_opened_at: "2026-09-10T09:00:00.000Z", ramp_override: 2 });
    await expect(floorsFor(client, "u1")).resolves.toEqual(
      { kcalMin: 1650, proteinGMin: 125, fatGMin: 50, carbGMin: 0 });
  });
  it("prefers the active profile's own floors when it has them", async () => {
    const { client } = clientWith({ ...PROFILE, protein_g_min: 140, kcal_min: 1700 });
    await expect(floorsFor(client, "u1")).resolves.toMatchObject({ proteinGMin: 140, kcalMin: 1700 });
  });
});

describe("authorTargets", () => {
  it("re-applies the floors server-side even when the client already did", async () => {
    const { client, insert } = clientWith(PROFILE);
    await authorTargets(client, "u1", { mode: "grams", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, grams: { proteinG: 100, fatG: 20, carbG: 300 } });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      protein_g: 135, fat_g: 50, authored_by: "user", user_id: "u1" }));
  });

  it("rejects a percent body under a floor and names the minimum percentage", async () => {
    const { client } = clientWith(PROFILE);
    const call = authorTargets(client, "u1", { mode: "percent", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, percent: { proteinPct: 20, fatPct: 30, carbPct: 50 } });
    await expect(call).rejects.toBeInstanceOf(FloorViolationError);
    await call.catch((e: FloorViolationError) => {
      expect(e.status).toBe(422);
      expect(e.code).toBe("protein_below_floor");
      expect(e.minProteinPct).toBeCloseTo(30.86, 2);
    });
  });

  it("round-trips a percent profile back to grams that reconstruct the calories", async () => {
    const { client } = clientWith(PROFILE);
    const out = await authorTargets(client, "u1", { mode: "percent", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, percent: { proteinPct: 31, fatPct: 30, carbPct: 39 } });
    const t = out.resolved.training;
    expect(Math.abs(4 * t.protein + 9 * t.fat + 4 * t.carbs - t.kcal)).toBeLessThanOrEqual(10);
  });
});
```

- [ ] Run: `pnpm test tests/targets/server-targets.test.ts` — expect `Failed to resolve import "@/lib/server/targets"`.
- [ ] Write `lib/server/targets.ts`:

```ts
/**
 * Target reads and the single authored write path. Every write re-applies the §3.4 floor sequence
 * server-side: the client copy is for display, never for authority (spec "Security").
 *
 * `activeTargets` returning null means "no profile is effective yet" — the authored ramp in
 * `lib/targets.ts` is still the target, and the ramp outranks the engine (spec "Scope: Out").
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { rampStageFor } from "@/lib/plan";
import { RAMP_TABLE } from "@/lib/targets";
import type { RampStage } from "@/lib/types";
import {
  applyFloors, CARB_G_MIN, FAT_G_MIN, KCAL_MIN, percentToGrams, proteinFloorForStage,
  resolveProfileMacros, validatePercentProfile, type MacroFloors,
} from "@/lib/targets/percent";
import type { TargetProfile, TargetsRequest, TargetsResponse } from "@/lib/api-types";

export class FloorViolationError extends HttpError {
  constructor(code: string, message: string,
    public readonly minProteinPct: number, public readonly minFatPct: number) {
    super(422, code, message);
    this.name = "FloorViolationError";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function activeProfile(
  client: SupabaseClient, userId: string,
): Promise<TargetProfile | null> {
  const { data, error } = await client.from("target_profiles").select("*")
    .eq("user_id", userId).lte("effective_from", today())
    .order("effective_from", { ascending: false }).order("rev", { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw error;
  return (data as TargetProfile | null) ?? null;
}

async function activeStage(client: SupabaseClient, userId: string): Promise<RampStage> {
  const { data, error } = await client.from("user_settings")
    .select("first_opened_at, ramp_override").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const firstOpenedAt = (data?.first_opened_at as string | undefined) ?? new Date().toISOString();
  const override = (data?.ramp_override as RampStage | null | undefined) ?? null;
  return rampStageFor(firstOpenedAt, today(), override);
}

/** The floor set in force: the active profile's own numbers, else targets.md's defaults with the
 *  protein floor pinned to the active ramp stage. */
export async function floorsFor(client: SupabaseClient, userId: string): Promise<MacroFloors> {
  const profile = await activeProfile(client, userId);
  if (profile) {
    return { kcalMin: profile.kcal_min, proteinGMin: Number(profile.protein_g_min),
      fatGMin: Number(profile.fat_g_min), carbGMin: Number(profile.carb_g_min) };
  }
  return { kcalMin: KCAL_MIN, proteinGMin: proteinFloorForStage(await activeStage(client, userId)),
    fatGMin: FAT_G_MIN, carbGMin: CARB_G_MIN };
}

/** The authored ramp, presented in the same shape as a profile so the screen has one code path. */
export async function rampTargets(
  client: SupabaseClient, userId: string,
): Promise<TargetsResponse> {
  const ramp = RAMP_TABLE[await activeStage(client, userId)];
  return { id: "ramp", mode: "grams", raisedToFloor: false,
    resolved: { training: ramp.training, rest: ramp.rest } };
}

export async function activeTargets(
  client: SupabaseClient, userId: string,
): Promise<TargetsResponse | null> {
  const profile = await activeProfile(client, userId);
  if (!profile) return null;
  const floors: MacroFloors = { kcalMin: profile.kcal_min,
    proteinGMin: Number(profile.protein_g_min), fatGMin: Number(profile.fat_g_min),
    carbGMin: Number(profile.carb_g_min) };
  const grams = profile.mode === "percent"
    ? percentToGrams(profile.kcal_train, { proteinPct: Number(profile.protein_pct),
        fatPct: Number(profile.fat_pct), carbPct: Number(profile.carb_pct) })
    : { proteinG: Number(profile.protein_g), fatG: Number(profile.fat_g),
        carbG: Number(profile.carb_g) };
  const resolved = resolveProfileMacros({ kcalTrain: profile.kcal_train,
    kcalRest: profile.kcal_rest, ...grams }, floors);
  return { id: profile.id, mode: profile.mode, raisedToFloor: resolved.raisedToFloor,
    resolved: { training: resolved.training, rest: resolved.rest } };
}

export async function authorTargets(
  client: SupabaseClient, userId: string, req: TargetsRequest,
): Promise<TargetsResponse> {
  const floors = await floorsFor(client, userId);

  if (req.mode === "percent") {
    if (!req.percent) throw new HttpError(400, "bad_request", "percent body required");
    const check = validatePercentProfile(req.percent, req.kcalTrain, req.kcalRest, floors);
    if (!check.ok) {
      throw new FloorViolationError(check.error,
        `At ${Math.min(req.kcalTrain, req.kcalRest)} kcal this split falls under a floor.`,
        check.minProteinPct, check.minFatPct);
    }
  } else if (!req.grams) {
    throw new HttpError(400, "bad_request", "grams body required");
  }

  const raw = req.mode === "percent"
    ? percentToGrams(req.kcalTrain, req.percent as NonNullable<TargetsRequest["percent"]>)
    : (req.grams as NonNullable<TargetsRequest["grams"]>);
  const floored = applyFloors(req.kcalTrain, raw, floors);

  const row = {
    user_id: userId, effective_from: req.effectiveFrom, rev: 1, authored_by: "user" as const,
    mode: req.mode, kcal_train: floored.kcal, kcal_rest: Math.max(req.kcalRest, floors.kcalMin),
    protein_g: floored.grams.proteinG, fat_g: floored.grams.fatG, carb_g: floored.grams.carbG,
    protein_pct: req.percent?.proteinPct ?? null, fat_pct: req.percent?.fatPct ?? null,
    carb_pct: req.percent?.carbPct ?? null,
    kcal_min: floors.kcalMin, protein_g_min: floors.proteinGMin, fat_g_min: floors.fatGMin,
    carb_g_min: floors.carbGMin,
    goal_rate_bp_week: req.goalRateBpWeek ?? 0, max_weekly_kcal_step: req.maxWeeklyKcalStep ?? 150,
  };
  const { data, error } = await client.from("target_profiles").insert(row).select("*").single();
  if (error) throw error;

  const profile = data as TargetProfile;
  const resolved = resolveProfileMacros({ kcalTrain: profile.kcal_train,
    kcalRest: profile.kcal_rest, proteinG: Number(profile.protein_g),
    fatG: Number(profile.fat_g), carbG: Number(profile.carb_g) }, floors);
  return { id: profile.id, mode: profile.mode,
    raisedToFloor: floored.raisedToFloor || resolved.raisedToFloor,
    resolved: { training: resolved.training, rest: resolved.rest } };
}
```

- [ ] Run: `pnpm test tests/targets/server-targets.test.ts` — expect PASS (9 tests).
- [ ] Commit: `git add lib/server/targets.ts tests/targets && git commit -m "feat(targets): server-side target reads and the authored write with re-applied floors"`

---

## Task 11 — `lib/server/expenditure.ts`

**Files**
- Create: `lib/server/expenditure.ts`
- Test: `tests/expenditure/server-expenditure.test.ts`

**Interfaces**
- Consumes: `daily_totals` view (`supabase/migrations/20260918090200_phase2_daily_totals.sql` — columns `user_id, local_date, nutrient_code, amount, items_with_value, items_total, coverage`); `upsert_expenditure_estimate(p_user_id, p_row)` (Task 1); `estimateExpenditure`, `PRIOR_KCAL`, `BMR_KCAL`, `ENGINE_VERSION`, `BURN_IN_QUALIFIED`, `WINDOW_DAYS`, `fromDayNumber`, `toDayNumber`; `type ExpenditureResponse`.
- Consumes **from Lane P** (contracts §2): `weighInsKg(client, userId, from, to): Promise<{ date: string; kg: number }[]>` in `lib/server/health-daily.ts`. Coded against the contract signature and injected as a port; the static import lands in Task 15 after the rebase onto P.
- Produces: `HISTORY_DAYS = 120`, `ENERGY_CODE = "energy_kcal"`; `type WeighInsPort`; `runEstimate(admin, userId, asOf, deps?)`; `latestEstimate(client, userId)`.

- [ ] Write the failing test `tests/expenditure/server-expenditure.test.ts`:

```ts
// tests/expenditure/server-expenditure.test.ts
import { describe, expect, it, vi } from "vitest";
import { latestEstimate, runEstimate } from "@/lib/server/expenditure";
import { ENGINE_VERSION } from "@/lib/expenditure";

const totalsRows = (days: number) => {
  const rows: Record<string, unknown>[] = [];
  for (let d = days; d >= 1; d -= 1) {
    const date = new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10);
    rows.push({ local_date: date, nutrient_code: "energy_kcal", amount: 2100, coverage: 1 });
    rows.push({ local_date: date, nutrient_code: "protein", amount: 135, coverage: 1 });
  }
  return rows;
};

function adminWith(rows: Record<string, unknown>[], estimate: Record<string, unknown> | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data: "e1", error: null });
  const from = vi.fn((table: string) => {
    if (table === "daily_totals") {
      return { select: () => ({ eq: () => ({ gte: () => ({ lte: () => ({
        order: async () => ({ data: rows, error: null }) }) }) }) }) };
    }
    return { select: () => ({ eq: () => ({ order: () => ({ limit: () => ({
      maybeSingle: async () => ({ data: estimate, error: null }) }) }) }) }) };
  });
  return { admin: { from, rpc } as never, rpc };
}

const weighIns = vi.fn(async () => {
  const out: { date: string; kg: number }[] = [];
  for (let d = 40; d >= 1; d -= 1) {
    out.push({ date: new Date(Date.UTC(2026, 8, 11) - d * 86_400_000).toISOString().slice(0, 10),
      kg: 57.5 - d * 0.004 });
  }
  return out;
});

describe("runEstimate", () => {
  it("turns daily_totals energy rows into IntakeDay and upserts through the RPC", async () => {
    const { admin, rpc } = adminWith(totalsRows(40));
    const result = await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(result.status).toBe("estimating");
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(rpc).toHaveBeenCalledWith("upsert_expenditure_estimate", expect.objectContaining({
      p_user_id: "u1",
      p_row: expect.objectContaining({ local_date: "2026-09-11", status: "estimating",
        engine_version: ENGINE_VERSION }),
    }));
  });

  it("seeds the prior from the previous stored estimate, not the constant", async () => {
    const { admin } = adminWith(totalsRows(40), { tdee_kcal: 2050, status: "estimating" });
    const result = await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(result.tdeeKcal).toBeLessThan(2200);
  });

  it("refuses to run without a weigh-ins port rather than inventing weights", async () => {
    const { admin } = adminWith(totalsRows(40));
    await expect(runEstimate(admin, "u1", "2026-09-11")).rejects.toMatchObject({ status: 503 });
  });

  it("ignores every nutrient except energy_kcal", async () => {
    const { admin, rpc } = adminWith(totalsRows(40).filter((r) => r.nutrient_code !== "energy_kcal"));
    await runEstimate(admin, "u1", "2026-09-11", { weighIns });
    expect(rpc.mock.calls[0][1].p_row.status).toBe("burn_in");
  });
});

describe("latestEstimate", () => {
  it("answers burn_in with nulls, not a 404, when no row exists", async () => {
    const { admin } = adminWith([], null);
    await expect(latestEstimate(admin, "u1")).resolves.toMatchObject({
      status: "burn_in", tdeeKcal: null, weightTrendKg: null, qualifiedDays: 0,
      weighInCount: 0, engineVersion: ENGINE_VERSION });
  });

  it("maps a stored row onto the wire type", async () => {
    const { admin } = adminWith([], { local_date: "2026-09-10", status: "estimating",
      tdee_kcal: "2210", weight_trend_kg: "57.4", intake_completeness: "0.93",
      qualified_days: 19, weigh_in_count: 18, confidence: "0.88", reason: null,
      engine_version: ENGINE_VERSION });
    await expect(latestEstimate(admin, "u1")).resolves.toEqual({
      status: "estimating", localDate: "2026-09-10", tdeeKcal: 2210, weightTrendKg: 57.4,
      confidence: 0.88, intakeCompleteness: 0.93, qualifiedDays: 19, weighInCount: 18,
      reason: null, engineVersion: ENGINE_VERSION });
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/server-expenditure.test.ts` — expect `Failed to resolve import "@/lib/server/expenditure"`.
- [ ] Write `lib/server/expenditure.ts`:

```ts
/**
 * The only impure piece of the estimator: it reads `daily_totals` and the weigh-ins, calls the
 * pure engine, and upserts one `expenditure_estimates` row per (user_id, local_date). The jobs
 * reach it through the privileged boundary (§2.2) with `p_user_id` from a query, never a body.
 *
 * Unit conversion happens in Lane P, not here and not in the view: `weigh_ins` returns each
 * sample's stored `value` and `unit` unconverted, and `weighInsKg` (contracts §2) runs every row
 * through `toCanonical('body_mass', value, unit)`, so a legacy `lb` backfill row and a Phase 5
 * `kg` sample enter the engine on the same footing. Q never reads `weigh_ins` directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import {
  BMR_KCAL, ENGINE_VERSION, estimateExpenditure, fromDayNumber, PRIOR_KCAL, toDayNumber,
  type ExpenditureResult, type IntakeDay, type WeighIn,
} from "@/lib/expenditure";
import type { ExpenditureResponse } from "@/lib/api-types";

/** How far back the engine reads. Long enough for the lifetime qualified-day gate to be honest. */
export const HISTORY_DAYS = 120;
export const ENERGY_CODE = "energy_kcal";

/** Lane P's `lib/server/health-daily.ts` export, by contract (contracts §2). */
export type WeighInsPort =
  (client: SupabaseClient, userId: string, from: string, to: string) => Promise<WeighIn[]>;

export type EstimateDeps = { weighIns?: WeighInsPort };

async function intakeDays(
  admin: SupabaseClient, userId: string, from: string, to: string,
): Promise<IntakeDay[]> {
  const { data, error } = await admin.from("daily_totals")
    .select("local_date, nutrient_code, amount, coverage")
    .eq("user_id", userId).gte("local_date", from).lte("local_date", to)
    .order("local_date", { ascending: true });
  if (error) throw error;
  return (data ?? [])
    .filter((row: Record<string, unknown>) => row.nutrient_code === ENERGY_CODE)
    .map((row: Record<string, unknown>) => ({
      date: String(row.local_date).slice(0, 10),
      kcal: Number(row.amount ?? 0),
      // coverage is null only when the day has no items at all; that is 0 coverage, not 100 %.
      energyCoverage: row.coverage === null ? 0 : Number(row.coverage),
    }));
}

async function priorFor(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin.from("expenditure_estimates")
    .select("tdee_kcal, status").eq("user_id", userId)
    .order("local_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const tdee = data?.tdee_kcal;
  return tdee === null || tdee === undefined ? PRIOR_KCAL : Number(tdee);
}

export async function runEstimate(
  admin: SupabaseClient, userId: string, asOf: string, deps?: EstimateDeps,
): Promise<ExpenditureResult> {
  const port = deps?.weighIns;
  if (!port) {
    throw new HttpError(503, "unavailable",
      "No weigh-ins port installed — Phase 5 health data is not on this deployment.");
  }
  const from = fromDayNumber(toDayNumber(asOf) - HISTORY_DAYS);
  const [intake, weighIns, priorKcal] = await Promise.all([
    intakeDays(admin, userId, from, asOf),
    port(admin, userId, from, asOf),
    priorFor(admin, userId),
  ]);

  const result = estimateExpenditure({ asOf, intake, weighIns, priorKcal, bmrKcal: BMR_KCAL });
  await upsertEstimate(admin, userId, asOf, result);
  return result;
}

export async function upsertEstimate(
  admin: SupabaseClient, userId: string, localDate: string, result: ExpenditureResult,
): Promise<string> {
  const { data, error } = await admin.rpc("upsert_expenditure_estimate", {
    p_user_id: userId,
    p_row: {
      local_date: localDate, status: result.status, tdee_kcal: result.tdeeKcal,
      weight_trend_kg: result.weightTrendKg, intake_avg_kcal: result.intakeAvgKcal,
      intake_completeness: result.intakeCompleteness, qualified_days: result.qualifiedDays,
      weigh_in_count: result.weighInCount, confidence: result.confidence,
      reason: result.reason, engine_version: result.engineVersion,
    },
  });
  if (error) throw error;
  return String(data);
}

/** Spec error case: no estimate yet is `200` with `burn_in` and nulls, never a 404. */
export async function latestEstimate(
  client: SupabaseClient, userId: string,
): Promise<ExpenditureResponse> {
  const { data, error } = await client.from("expenditure_estimates")
    .select("local_date, status, tdee_kcal, weight_trend_kg, intake_completeness, qualified_days, weigh_in_count, confidence, reason, engine_version")
    .eq("user_id", userId).order("local_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    return { status: "burn_in", localDate: new Date().toISOString().slice(0, 10),
      tdeeKcal: null, weightTrendKg: null, confidence: 0, intakeCompleteness: 0,
      qualifiedDays: 0, weighInCount: 0, reason: "Learning your numbers — 0 of 21 days",
      engineVersion: ENGINE_VERSION };
  }
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    status: data.status as ExpenditureResponse["status"],
    localDate: String(data.local_date).slice(0, 10),
    tdeeKcal: num(data.tdee_kcal), weightTrendKg: num(data.weight_trend_kg),
    confidence: Number(data.confidence ?? 0),
    intakeCompleteness: Number(data.intake_completeness ?? 0),
    qualifiedDays: Number(data.qualified_days ?? 0),
    weighInCount: Number(data.weigh_in_count ?? 0),
    reason: (data.reason as string | null) ?? null,
    engineVersion: String(data.engine_version ?? ENGINE_VERSION),
  };
}
```

- [ ] Run: `pnpm test tests/expenditure/server-expenditure.test.ts` — expect PASS (6 tests).
- [ ] Commit: `git add lib/server/expenditure.ts tests/expenditure && git commit -m "feat(expenditure): the server read path and the estimate upsert"`

---

## Task 12 — `lib/server/proposals.ts`

**Files**
- Create: `lib/server/proposals.ts`
- Test: `tests/proposals/server-proposals.test.ts`

**Interfaces**
- Consumes: `approve_target_proposal(p_user_id, p_proposal_id)` (Task 1); `HttpError`; `type DecideRequest`, `type DecideResponse`, `type ProposalSummary`, `type ProposedTargets`.
- Produces: `class ProposalConflictError extends HttpError { current: ProposalSummary }`; `listProposals(client, userId, status?)`; `decideProposal(client, userId, proposalId, req)`; `toSummary(row)`.

- [ ] Write the failing test `tests/proposals/server-proposals.test.ts`:

```ts
// tests/proposals/server-proposals.test.ts
import { describe, expect, it, vi } from "vitest";
import { decideProposal, listProposals, ProposalConflictError } from "@/lib/server/proposals";

const PROPOSED = { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
  deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false };
const ROW = { id: "pr1", week_start: "2026-09-14", created_at: "2026-09-13T21:00:00.000Z",
  status: "pending", based_on_estimate_id: "e1", proposed: PROPOSED };

function clientWith(rows: Record<string, unknown>[], rpcResult: unknown, updated: unknown = ROW) {
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult, error: null });
  const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({
    select: () => ({ maybeSingle: async () => ({ data: updated, error: null }) }) }) }) }) }));
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      order: async () => ({ data: rows, error: null }) }) }),
    update,
  }));
  return { client: { from, rpc } as never, rpc, update };
}

describe("listProposals", () => {
  it("maps rows onto the wire type", async () => {
    const { client } = clientWith([ROW], null);
    await expect(listProposals(client, "u1", "pending")).resolves.toEqual([{
      id: "pr1", weekStart: "2026-09-14", createdAt: "2026-09-13T21:00:00.000Z",
      status: "pending", basedOnEstimateId: "e1", proposed: PROPOSED }]);
  });
});

describe("decideProposal — approve", () => {
  it("runs the one-transaction RPC and returns the new profile id", async () => {
    const { client, rpc } = clientWith([ROW],
      { status: "approved", target_profile_id: "tp1" });
    await expect(decideProposal(client, "u1", "pr1",
      { decision: "approve", expectedStatus: "pending" }))
      .resolves.toEqual({ status: "approved", targetProfileId: "tp1" });
    expect(rpc).toHaveBeenCalledWith("approve_target_proposal",
      { p_user_id: "u1", p_proposal_id: "pr1" });
  });

  it("raises 409 carrying the current row when it was already decided", async () => {
    const { client } = clientWith([ROW],
      { status: "conflict", current: { ...ROW, status: "approved" } });
    const call = decideProposal(client, "u1", "pr1",
      { decision: "approve", expectedStatus: "pending" });
    await expect(call).rejects.toBeInstanceOf(ProposalConflictError);
    await call.catch((e: ProposalConflictError) => {
      expect(e.status).toBe(409);
      expect(e.current.status).toBe("approved");
    });
  });

  it("404s another user's proposal id — RLS makes it invisible", async () => {
    const { client } = clientWith([], { status: "not_found" });
    await expect(decideProposal(client, "u1", "pr9",
      { decision: "approve", expectedStatus: "pending" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("decideProposal — reject", () => {
  it("writes no profile and updates only a row still in expectedStatus", async () => {
    const { client, update, rpc } = clientWith([ROW], null, { ...ROW, status: "rejected" });
    await expect(decideProposal(client, "u1", "pr1",
      { decision: "reject", expectedStatus: "pending" }))
      .resolves.toEqual({ status: "rejected", targetProfileId: null });
    expect(rpc).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", decided_by: "u1" }));
  });

  it("409s when the CAS update matches nothing but the row exists", async () => {
    const { client } = clientWith([{ ...ROW, status: "approved" }], null, null);
    await expect(decideProposal(client, "u1", "pr1",
      { decision: "reject", expectedStatus: "pending" })).rejects.toBeInstanceOf(ProposalConflictError);
  });
});
```

- [ ] Run: `pnpm test tests/proposals/server-proposals.test.ts` — expect `Failed to resolve import "@/lib/server/proposals"`.
- [ ] Write `lib/server/proposals.ts`:

```ts
/**
 * Proposal reads and the decide path. Approval is one transaction inside
 * `approve_target_proposal` (§3.7 change_log rows included); rejection is a compare-and-swap
 * update, so a second tap cannot silently overwrite a decision made on the other device.
 *
 * Both run on the CALLER's RLS-scoped client: `_sync_assert_caller` inside the function checks the
 * same identity again, and another user's proposal id is simply invisible (spec: assert 404).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type {
  DecideRequest, DecideResponse, ProposalSummary, ProposedTargets,
} from "@/lib/api-types";

export class ProposalConflictError extends HttpError {
  constructor(public readonly current: ProposalSummary) {
    super(409, "conflict", "This proposal was already decided.");
    this.name = "ProposalConflictError";
  }
}

export function toSummary(row: Record<string, unknown>): ProposalSummary {
  return {
    id: String(row.id),
    weekStart: String(row.week_start ?? "").slice(0, 10),
    createdAt: String(row.created_at),
    status: row.status as ProposalSummary["status"],
    basedOnEstimateId: (row.based_on_estimate_id as string | null) ?? null,
    proposed: row.proposed as ProposedTargets,
  };
}

export async function listProposals(
  client: SupabaseClient, userId: string, status?: ProposalSummary["status"],
): Promise<ProposalSummary[]> {
  const query = client.from("target_proposals")
    .select("id, week_start, created_at, status, based_on_estimate_id, proposed")
    .eq("user_id", userId);
  const { data, error } = await (status
    ? query.eq("status", status).order("week_start", { ascending: false })
    : query.order("week_start", { ascending: false }));
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

async function readOne(
  client: SupabaseClient, userId: string, proposalId: string,
): Promise<ProposalSummary | null> {
  const { data, error } = await client.from("target_proposals")
    .select("id, week_start, created_at, status, based_on_estimate_id, proposed")
    .eq("user_id", userId).eq("id", proposalId).maybeSingle();
  if (error) throw error;
  return data ? toSummary(data) : null;
}

export async function decideProposal(
  client: SupabaseClient, userId: string, proposalId: string, req: DecideRequest,
): Promise<DecideResponse> {
  if (req.decision === "approve") {
    const { data, error } = await client.rpc("approve_target_proposal",
      { p_user_id: userId, p_proposal_id: proposalId });
    if (error) throw error;
    const result = data as { status: string; target_profile_id?: string; current?: Record<string, unknown> };
    if (result.status === "not_found") throw new HttpError(404, "not_found", "No such proposal.");
    if (result.status === "conflict") {
      throw new ProposalConflictError(toSummary(result.current as Record<string, unknown>));
    }
    return { status: "approved", targetProfileId: String(result.target_profile_id) };
  }

  const { data, error } = await client.from("target_proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: userId })
    .eq("user_id", userId).eq("id", proposalId).eq("status", req.expectedStatus)
    .select("id, week_start, created_at, status, based_on_estimate_id, proposed").maybeSingle();
  if (error) throw error;
  if (data) return { status: "rejected", targetProfileId: null };

  // Nothing matched: either the row is invisible (another user, or gone) or it moved on.
  const current = await readOne(client, userId, proposalId);
  if (!current) throw new HttpError(404, "not_found", "No such proposal.");
  throw new ProposalConflictError(current);
}
```

- [ ] Run: `pnpm test tests/proposals/server-proposals.test.ts` — expect PASS (6 tests).
- [ ] Commit: `git add lib/server/proposals.ts tests/proposals && git commit -m "feat(proposals): list and decide with compare-and-swap and a 409 carrying the current row"`

---

## Task 13 — The three JWT read routes

**Files**
- Create: `app/api/expenditure/route.ts`, `app/api/proposals/route.ts`, `app/api/targets/route.ts`
- Test: `tests/expenditure/expenditure-route.test.ts`, `tests/targets/targets-route.test.ts`

**Interfaces**
- Consumes: `requireUser(req)`, `HttpError` (`lib/server/auth.ts`); `jsonError`, `readJson` (`lib/server/http.ts`); `enforceRateLimit(key, limit, windowSeconds)` (`lib/server/ratelimit.ts`); `latestEstimate`, `activeTargets`, `rampTargets`, `authorTargets`, `FloorViolationError`, `listProposals`.
- Produces: `GET /api/expenditure` (60/min/user), `GET /api/proposals?status=pending` (60/min/user), `GET`/`POST /api/targets` (30/min/user, 8 KB).

- [ ] Write the failing tests:

```ts
// tests/expenditure/expenditure-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const latestEstimate = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/expenditure", () => ({ latestEstimate: (...a: unknown[]) => latestEstimate(...a) }));
const { GET } = await import("@/app/api/expenditure/route");
const { HttpError } = await import("@/lib/server/auth");

beforeEach(() => {
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  latestEstimate.mockReset().mockResolvedValue({ status: "burn_in", tdeeKcal: null });
});

describe("GET /api/expenditure", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await GET(new Request("https://x.test/api/expenditure"))).status).toBe(401);
  });
  it("rate-limits at 60 a minute keyed by the user, after identity", async () => {
    await GET(new Request("https://x.test/api/expenditure"));
    expect(enforceRateLimit).toHaveBeenCalledWith("expenditure:user:u1", 60, 60);
  });
  it("answers 200 with burn_in and nulls rather than 404", async () => {
    const res = await GET(new Request("https://x.test/api/expenditure"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "burn_in", tdeeKcal: null });
  });
});
```

```ts
// tests/targets/targets-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const activeTargets = vi.fn();
const rampTargets = vi.fn();
const authorTargets = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/targets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/targets")>("@/lib/server/targets");
  return { ...actual, activeTargets: (...a: unknown[]) => activeTargets(...a),
    rampTargets: (...a: unknown[]) => rampTargets(...a),
    authorTargets: (...a: unknown[]) => authorTargets(...a) };
});
const { GET, POST } = await import("@/app/api/targets/route");
const { FloorViolationError } = await import("@/lib/server/targets");

const post = (body: unknown) => new Request("https://x.test/api/targets", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const BODY = { mode: "grams", effectiveFrom: "2026-09-14", kcalTrain: 2200, kcalRest: 1750,
  grams: { proteinG: 135, fatG: 85, carbG: 200 } };

beforeEach(() => {
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  activeTargets.mockReset().mockResolvedValue(null);
  rampTargets.mockReset().mockResolvedValue({ id: "ramp", mode: "grams", raisedToFloor: false,
    resolved: { training: { kcal: 2200, protein: 135, carbs: 200, fat: 95 },
      rest: { kcal: 1750, protein: 135, carbs: 110, fat: 85 } } });
  authorTargets.mockReset().mockResolvedValue({ id: "p2", mode: "grams", raisedToFloor: false,
    resolved: { training: { kcal: 2200, protein: 135, carbs: 204, fat: 85 },
      rest: { kcal: 1750, protein: 135, carbs: 91, fat: 85 } } });
});

describe("GET /api/targets", () => {
  it("falls back to the ramp when no profile is effective", async () => {
    const res = await GET(new Request("https://x.test/api/targets"));
    expect(enforceRateLimit).toHaveBeenCalledWith("targets:user:u1", 30, 60);
    await expect(res.json()).resolves.toMatchObject({ id: "ramp" });
  });
});

describe("POST /api/targets", () => {
  it("writes an authored profile and returns the resolved grams", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: "p2" });
  });
  it("rejects a body over 8 KB", async () => {
    const res = await POST(post({ ...BODY, effectiveFrom: "x".repeat(9000) }));
    expect(res.status).toBe(413);
  });
  it("rejects a bad shape with 400 and never echoes the body", async () => {
    const res = await POST(post({ mode: "vibes", effectiveFrom: "2026-09-14" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("vibes");
  });
  it("answers 422 naming the minimum percentage when a floor is broken", async () => {
    authorTargets.mockRejectedValue(new FloorViolationError("protein_below_floor", "under", 30.86, 25.72));
    const res = await POST(post({ ...BODY, mode: "percent", grams: undefined,
      percent: { proteinPct: 20, fatPct: 30, carbPct: 50 } }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: "protein_below_floor", minProteinPct: 30.86, minFatPct: 25.72 });
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/expenditure-route.test.ts tests/targets/targets-route.test.ts` — expect both to fail on the missing route modules.
- [ ] Write `app/api/expenditure/route.ts`:

```ts
/** GET /api/expenditure — JWT, read-only, 60/min/user (spec "Security"). RLS does the scoping. */
import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { latestEstimate } from "@/lib/server/expenditure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await enforceRateLimit(`expenditure:ip:${ip}`, 60, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`expenditure:user:${userId}`, 60, 60);
    return Response.json(await latestEstimate(client, userId));
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `app/api/proposals/route.ts`:

```ts
/** GET /api/proposals?status=pending — JWT, read-only, 60/min/user. */
import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { listProposals } from "@/lib/server/proposals";
import type { ProposalSummary } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["pending", "approved", "rejected"]);

export async function GET(req: Request): Promise<Response> {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await enforceRateLimit(`proposals:ip:${ip}`, 60, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`proposals:user:${userId}`, 60, 60);
    const raw = new URL(req.url).searchParams.get("status");
    const status = raw && STATUSES.has(raw) ? (raw as ProposalSummary["status"]) : undefined;
    return Response.json(await listProposals(client, userId, status));
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `app/api/targets/route.ts`:

```ts
/** GET/POST /api/targets — JWT, 8 KB, 30/min/user. The floor sequence is re-applied server-side
 *  in `authorTargets`; a 422 names the minimum percentage that satisfies the floor. */
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { activeTargets, authorTargets, FloorViolationError, rampTargets } from "@/lib/server/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024;

const bodySchema = z.object({
  mode: z.enum(["grams", "percent"]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kcalTrain: z.number().int().min(800).max(6000),
  kcalRest: z.number().int().min(800).max(6000),
  grams: z.object({ proteinG: z.number().min(0).max(500), fatG: z.number().min(0).max(400),
    carbG: z.number().min(0).max(900) }).optional(),
  percent: z.object({ proteinPct: z.number().min(5).max(70), fatPct: z.number().min(5).max(70),
    carbPct: z.number().min(5).max(70) }).optional(),
  goalRateBpWeek: z.number().int().min(-200).max(200).optional(),
  maxWeeklyKcalStep: z.number().int().min(0).max(1000).optional(),
});

async function limits(req: Request): Promise<{ userId: string; client: Parameters<typeof activeTargets>[0] }> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  await enforceRateLimit(`targets:ip:${ip}`, 30, 60);
  const { userId, client } = await requireUser(req);
  await enforceRateLimit(`targets:user:${userId}`, 30, 60);
  return { userId, client };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { userId, client } = await limits(req);
    return Response.json(await activeTargets(client, userId) ?? await rampTargets(client, userId));
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await limits(req);
    const body = await readJson(req, bodySchema, MAX_BYTES);
    return Response.json(await authorTargets(client, userId, body));
  } catch (e) {
    if (e instanceof FloorViolationError) {
      return Response.json({ error: e.code, message: e.message,
        minProteinPct: e.minProteinPct, minFatPct: e.minFatPct }, { status: 422 });
    }
    return jsonError(e);
  }
}
```

- [ ] Run: `pnpm test tests/expenditure/expenditure-route.test.ts tests/targets/targets-route.test.ts` — expect PASS (8 tests).
- [ ] Commit: `git add app/api/expenditure app/api/proposals app/api/targets tests && git commit -m "feat(api): expenditure, proposals and targets read routes"`

---

## Task 14 — The decide route

**Files**
- Create: `app/api/proposals/[id]/decide/route.ts`
- Test: `tests/proposals/decide-route.test.ts`

**Interfaces**
- Consumes: `decideProposal`, `ProposalConflictError`; `requireUser`, `readJson`, `jsonError`, `enforceRateLimit`.
- Produces: `POST /api/proposals/[id]/decide` — JWT, 4 KB, 30/min/user, `expectedStatus` CAS, 409 carrying the current row, 404 for another user's id.

- [ ] Write the failing test `tests/proposals/decide-route.test.ts`:

```ts
// tests/proposals/decide-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const decide = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/proposals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/proposals")>("@/lib/server/proposals");
  return { ...actual, decideProposal: (...a: unknown[]) => decide(...a) };
});
const { POST } = await import("@/app/api/proposals/[id]/decide/route");
const { ProposalConflictError } = await import("@/lib/server/proposals");
const { HttpError } = await import("@/lib/server/auth");

const CURRENT = { id: "pr1", weekStart: "2026-09-14", createdAt: "2026-09-13T21:00:00.000Z",
  status: "approved" as const, basedOnEstimateId: "e1",
  proposed: { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
    deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false } };

const call = (body: unknown, id = "pr1") => POST(
  new Request(`https://x.test/api/proposals/${id}/decide`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) });

beforeEach(() => {
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: {} });
  decide.mockReset().mockResolvedValue({ status: "approved", targetProfileId: "tp1" });
});

describe("POST /api/proposals/[id]/decide", () => {
  it("401s without a session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await call({ decision: "approve", expectedStatus: "pending" })).status).toBe(401);
  });
  it("rate-limits at 30 a minute keyed by the user", async () => {
    await call({ decision: "approve", expectedStatus: "pending" });
    expect(enforceRateLimit).toHaveBeenCalledWith("proposals:decide:u1", 30, 60);
  });
  it("approves and returns the new target_profiles id", async () => {
    const res = await call({ decision: "approve", expectedStatus: "pending" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "approved", targetProfileId: "tp1" });
    expect(decide).toHaveBeenCalledWith({}, "u1", "pr1",
      { decision: "approve", expectedStatus: "pending" });
  });
  it("400s a body missing expectedStatus", async () => {
    expect((await call({ decision: "approve" })).status).toBe(400);
  });
  it("413s a body over 4 KB", async () => {
    expect((await call({ decision: "approve", expectedStatus: "pending",
      pad: "x".repeat(5000) })).status).toBe(413);
  });
  it("409s carrying the current row when it was already decided", async () => {
    decide.mockRejectedValue(new ProposalConflictError(CURRENT));
    const res = await call({ decision: "approve", expectedStatus: "pending" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "conflict", current: { status: "approved" } });
  });
  it("404s another user's proposal id", async () => {
    decide.mockRejectedValue(new HttpError(404, "not_found"));
    expect((await call({ decision: "reject", expectedStatus: "pending" }, "pr9")).status).toBe(404);
  });
});
```

- [ ] Run: `pnpm test tests/proposals/decide-route.test.ts` — expect the missing-module failure.
- [ ] Write `app/api/proposals/[id]/decide/route.ts`:

```ts
/** POST /api/proposals/[id]/decide — JWT, 4 KB, 30/min/user, `expectedStatus` CAS (spec
 *  "Security"). Approval is one transaction inside `approve_target_proposal`. */
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { decideProposal, ProposalConflictError } from "@/lib/server/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024;

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  expectedStatus: z.literal("pending"),
});

export async function POST(
  req: Request, ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await enforceRateLimit(`proposals:decide:ip:${ip}`, 30, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`proposals:decide:${userId}`, 30, 60);

    const body = await readJson(req, bodySchema, MAX_BYTES);
    const { id } = await ctx.params;
    return Response.json(await decideProposal(client, userId, id, body));
  } catch (e) {
    if (e instanceof ProposalConflictError) {
      return Response.json({ error: "conflict",
        message: "This proposal was already decided.", current: e.current }, { status: 409 });
    }
    return jsonError(e);
  }
}
```

- [ ] Run: `pnpm test tests/proposals/decide-route.test.ts` — expect PASS (7 tests).
- [ ] Commit: `git add app/api/proposals tests/proposals && git commit -m "feat(api): proposal decide route with expectedStatus CAS"`

---

## Task 15 — The two cron jobs

**Files**
- Create: `app/api/jobs/estimate/route.ts`, `app/api/jobs/weekly-proposal/route.ts`
- Test: `tests/expenditure/jobs.test.ts`

**Interfaces**
- Consumes: the cron pattern of `app/api/jobs/backup/route.ts:52–60` (timing-safe `CRON_SECRET`, rate limit first); `adminClient()`; `runEstimate`, `upsertEstimate`, `latestEstimate`; `activeProfile`; `buildProposal`; `blockedFrom`; `job_runs(job, user_id, run_key, status)` from Lane P's `20260926000000_phase5_oura_oauth.sql` (contracts §2).
- Consumes **from Lane P**: `weighInsKg` in `lib/server/health-daily.ts` — **rebase onto the landed `main` before this task** (land order P → Q). Until then the import does not resolve; the tests inject the port.
- Produces: `POST /api/jobs/estimate`, `POST /api/jobs/weekly-proposal`, both returning `JobResponse`; `DEFAULT_TZ = "America/New_York"`; `mondayOf(date: string): string`.

- [ ] Write the failing test `tests/expenditure/jobs.test.ts`:

```ts
// tests/expenditure/jobs.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const enforceRateLimit = vi.fn();
const admin = { from: vi.fn(), rpc: vi.fn() };
const runEstimate = vi.fn();
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/expenditure", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/expenditure")>("@/lib/server/expenditure");
  return { ...actual, runEstimate: (...a: unknown[]) => runEstimate(...a) };
});
vi.mock("@/lib/server/health-daily", () => ({ weighInsKg: vi.fn(async () => []) }));
const { POST, mondayOf } = await import("@/app/api/jobs/estimate/route");

const lockOk = () => ({ insert: () => ({ select: async () => ({ data: [{}], error: null }) }),
  update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
  select: () => ({ eq: async () => ({ data: [{ user_id: "u1" }], error: null }) }) });
const lockHeld = () => ({ ...lockOk(),
  insert: () => ({ select: async () => ({ data: null, error: { code: "23505" } }) }) });

const call = (secret = "s3cret") => POST(new Request("https://x.test/api/jobs/estimate",
  { method: "POST", headers: { authorization: `Bearer ${secret}` } }));

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.ESTIMATOR_ENABLED = "1";
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  runEstimate.mockReset().mockResolvedValue({ status: "estimating", tdeeKcal: 2200 });
  admin.from.mockReset().mockImplementation((t: string) =>
    t === "user_settings" ? { select: () => ({ not: async () => ({ data: [{ user_id: "u1" }], error: null }) }) } : lockOk());
});

describe("POST /api/jobs/estimate", () => {
  it("rate-limits before it compares the secret", async () => {
    await call("wrong");
    expect(enforceRateLimit).toHaveBeenCalledWith("jobs:estimate", 10, 3600);
  });
  it("401s a bad cron secret", async () => {
    expect((await call("wrong")).status).toBe(401);
  });
  it("503s when ESTIMATOR_ENABLED is unset", async () => {
    delete process.env.ESTIMATOR_ENABLED;
    expect((await call()).status).toBe(503);
  });
  it("runs one estimate per user and reports the counts", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ran: 1, skipped: 0, errors: 0 });
    expect(runEstimate).toHaveBeenCalledTimes(1);
  });
  it("skips a user whose per-day lock is already held", async () => {
    admin.from.mockImplementation((t: string) =>
      t === "user_settings" ? { select: () => ({ not: async () => ({ data: [{ user_id: "u1" }], error: null }) }) } : lockHeld());
    await expect((await call()).json()).resolves.toEqual({ ran: 0, skipped: 1, errors: 0 });
    expect(runEstimate).not.toHaveBeenCalled();
  });
  it("counts a thrown estimate as an error and keeps going", async () => {
    runEstimate.mockRejectedValue(new Error("boom"));
    await expect((await call()).json()).resolves.toEqual({ ran: 0, skipped: 0, errors: 1 });
  });
});

describe("mondayOf", () => {
  it("returns the Monday that starts the week a date falls in", () => {
    expect(mondayOf("2026-09-13")).toBe("2026-09-07");   // a Sunday belongs to the week just ending
    expect(mondayOf("2026-09-14")).toBe("2026-09-14");
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/jobs.test.ts` — expect the missing-module failure.
- [ ] Write `app/api/jobs/estimate/route.ts`:

```ts
/**
 * POST /api/jobs/estimate — Vercel cron, nightly 03:00 user tz (`vercel.json`: `0 7 * * *` UTC).
 *
 * Gate chain, in the order wave-4 contracts §9 fixes: rate limit → timing-safe CRON_SECRET →
 * ESTIMATOR_ENABLED → per-user `job_runs` lock. The user ids come from a query this handler
 * scopes, never from a request body (§2.2). Harmless with the UI off: it writes only
 * `expenditure_estimates`.
 */
import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { runEstimate } from "@/lib/server/expenditure";
import { weighInsKg } from "@/lib/server/health-daily";
import type { JobResponse } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Her zone. `user_settings` carries no tz column, so the job uses one house zone and the
 *  estimate's `local_date` is that zone's date (spec open question: see Open questions 5). */
export const DEFAULT_TZ = "America/New_York";
export const JOB_NAME = "estimate";

export function localDateIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
    day: "2-digit" }).format(now);
}

/** The Monday that starts the week a date belongs to; a Sunday belongs to the week just ending. */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = Date.UTC(y, m - 1, d);
  const dow = new Date(at).getUTCDay();               // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  return new Date(at - back * 86_400_000).toISOString().slice(0, 10);
}

export function cronSecretOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function jobUserIds(admin: ReturnType<typeof adminClient>): Promise<string[]> {
  const { data, error } = await admin.from("user_settings").select("user_id").not("user_id", "is", null);
  if (error) throw error;
  return [...new Set((data ?? []).map((r: { user_id: string }) => r.user_id))];
}

/** Returns false when another run already holds this (job, user, key). */
export async function takeLock(
  admin: ReturnType<typeof adminClient>, job: string, userId: string, runKey: string,
): Promise<boolean> {
  const { error } = await admin.from("job_runs")
    .insert({ job, user_id: userId, run_key: runKey, status: "running" }).select("job");
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

export async function releaseLock(
  admin: ReturnType<typeof adminClient>, job: string, userId: string, runKey: string,
  status: "ok" | "error", detail?: unknown,
): Promise<void> {
  await admin.from("job_runs")
    .update({ status, finished_at: new Date().toISOString(), detail: detail ?? null })
    .eq("job", job).eq("user_id", userId).eq("run_key", runKey);
}

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit("jobs:estimate", 10, 3600);
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    if (!process.env.ESTIMATOR_ENABLED) {
      throw new HttpError(503, "unavailable", "ESTIMATOR_ENABLED is off");
    }
    const admin = adminClient();
    const asOf = localDateIn(DEFAULT_TZ);
    const out: JobResponse = { ran: 0, skipped: 0, errors: 0 };

    for (const userId of await jobUserIds(admin)) {
      if (!(await takeLock(admin, JOB_NAME, userId, asOf))) {
        out.skipped += 1;
        continue;
      }
      try {
        const result = await runEstimate(admin, userId, asOf, { weighIns: weighInsKg });
        await releaseLock(admin, JOB_NAME, userId, asOf, "ok", { status: result.status });
        out.ran += 1;
      } catch (e) {
        await releaseLock(admin, JOB_NAME, userId, asOf, "error",
          { message: e instanceof Error ? e.message : "unknown" });
        out.errors += 1;
      }
    }
    return Response.json(out);
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Write `app/api/jobs/weekly-proposal/route.ts`:

```ts
/**
 * POST /api/jobs/weekly-proposal — Vercel cron, Sunday 21:00 user tz (`vercel.json`:
 * `0 1 * * 1` UTC). Idempotent on `(user_id, week_start)` through both the `job_runs` lock and
 * the unique index; a second Sunday auto-rejects the older pending row rather than stacking a
 * second card (spec open question 6, ASSUMED).
 *
 * Only `status = 'estimating'` produces a proposal. A `blocked` outcome writes a blocked ESTIMATE
 * and no proposal — the engine refuses, Devin decides.
 */
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { blockedFrom, type ExpenditureResult } from "@/lib/expenditure";
import { buildProposal } from "@/lib/proposal";
import { activeProfile } from "@/lib/server/targets";
import { runEstimate, upsertEstimate } from "@/lib/server/expenditure";
import { weighInsKg } from "@/lib/server/health-daily";
import {
  cronSecretOk, DEFAULT_TZ, jobUserIds, localDateIn, mondayOf, releaseLock, takeLock,
} from "@/app/api/jobs/estimate/route";
import type { JobResponse, TargetProfile } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const JOB_NAME = "weekly-proposal";

async function writeProposal(
  admin: ReturnType<typeof adminClient>, userId: string, weekStart: string,
  estimate: ExpenditureResult, active: TargetProfile, asOf: string,
): Promise<"proposed" | "none"> {
  const built = buildProposal({ estimate, active });

  if (built.kind === "blocked") {
    await upsertEstimate(admin, userId, asOf, blockedFrom(estimate, built.reason));
    return "none";
  }
  if (built.kind === "none") return "none";

  const { data: est } = await admin.from("expenditure_estimates").select("id")
    .eq("user_id", userId).eq("local_date", asOf).maybeSingle();

  const { error } = await admin.from("target_proposals").insert({
    user_id: userId, week_start: weekStart, status: "pending",
    based_on_estimate_id: est?.id ?? null, proposed: built.proposed });
  // 23505 is the per-user-week unique index: this week already has a proposal, which is the
  // idempotency the spec measures (acceptance criterion 5).
  if (error && (error as { code?: string }).code !== "23505") throw error;
  if (error) return "none";

  // The newest card replaces the older pending one instead of stacking (open question 6).
  await admin.from("target_proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("user_id", userId).eq("status", "pending").neq("week_start", weekStart);
  return "proposed";
}

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit("jobs:weekly-proposal", 10, 3600);
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    if (!process.env.ESTIMATOR_ENABLED) {
      throw new HttpError(503, "unavailable", "ESTIMATOR_ENABLED is off");
    }
    const admin = adminClient();
    const asOf = localDateIn(DEFAULT_TZ);
    const weekStart = mondayOf(asOf);
    const out: JobResponse = { ran: 0, skipped: 0, errors: 0 };

    for (const userId of await jobUserIds(admin)) {
      if (!(await takeLock(admin, JOB_NAME, userId, weekStart))) {
        out.skipped += 1;
        continue;
      }
      try {
        const estimate = await runEstimate(admin, userId, asOf, { weighIns: weighInsKg });
        const active = await activeProfile(admin, userId);
        const written = active
          ? await writeProposal(admin, userId, weekStart, estimate, active, asOf)
          : "none";
        await releaseLock(admin, JOB_NAME, userId, weekStart, "ok",
          { status: estimate.status, written });
        out.ran += 1;
      } catch (e) {
        await releaseLock(admin, JOB_NAME, userId, weekStart, "error",
          { message: e instanceof Error ? e.message : "unknown" });
        out.errors += 1;
      }
    }
    return Response.json(out);
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Run: `pnpm test tests/expenditure/jobs.test.ts` — expect PASS (8 tests).
- [ ] Commit: `git add app/api/jobs tests/expenditure && git commit -m "feat(jobs): nightly estimate and Sunday proposal jobs with per-user locks"`

---

## Task 16 — MCP tools

**Files**
- Create: `lib/mcp/expenditure-tools.ts`
- Test: `tests/expenditure/mcp-tools.test.ts`

**Interfaces**
- Consumes: `createMcpHandler` (`mcp-handler`, the shape `app/api/mcp/route.ts:56` already uses); `latestEstimate`; `activeTargets`, `rampTargets`.
- Produces: `type McpServer`; `registerExpenditureTools(server: McpServer, ctx: { userId: string; admin: SupabaseClient }): void`; `EXPENDITURE_TOOL_SCOPES: Record<"get_expenditure_status" | "get_targets", "read">`.

- [ ] Write the failing test `tests/expenditure/mcp-tools.test.ts`:

```ts
// tests/expenditure/mcp-tools.test.ts
import { describe, expect, it, vi } from "vitest";
import { EXPENDITURE_TOOL_SCOPES, registerExpenditureTools } from "@/lib/mcp/expenditure-tools";

type Registered = { name: string; handler: (args: unknown) => Promise<{ content: { text: string }[] }> };

function fakeServer() {
  const tools: Registered[] = [];
  const server = { registerTool: (name: string, _cfg: unknown, handler: Registered["handler"]) =>
    tools.push({ name, handler }) };
  return { server: server as never, tools };
}

const admin = {
  from: vi.fn(() => ({ select: () => ({ eq: () => ({
    order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    lte: () => ({ order: () => ({ order: () => ({ limit: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    maybeSingle: async () => ({ data: { first_opened_at: "2026-08-01T00:00:00.000Z",
      ramp_override: 3 }, error: null }) }) }) })),
} as never;

describe("registerExpenditureTools", () => {
  it("registers exactly the two read-only tools the contracts name", () => {
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    expect(tools.map((t) => t.name)).toEqual(["get_expenditure_status", "get_targets"]);
    expect(EXPENDITURE_TOOL_SCOPES).toEqual(
      { get_expenditure_status: "read", get_targets: "read" });
  });

  it("get_expenditure_status answers burn_in with nulls when there is no estimate", async () => {
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    const out = await tools[0].handler({});
    expect(JSON.parse(out.content[0].text)).toMatchObject({ status: "burn_in", tdeeKcal: null });
  });

  it("get_targets falls back to the authored ramp", async () => {
    const { server, tools } = fakeServer();
    registerExpenditureTools(server, { userId: "u1", admin });
    const out = await tools[1].handler({});
    expect(JSON.parse(out.content[0].text)).toMatchObject({ id: "ramp" });
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/mcp-tools.test.ts` — expect the missing-module failure.
- [ ] Write `lib/mcp/expenditure-tools.ts`:

```ts
/**
 * The estimator's MCP surface: read-only, no write path to targets in this phase (spec "User
 * stories — Agent via MCP"). `get_expenditure_status` ships here, not in Phase 7 (contracts §3,
 * reconciled); the coach's registry calls `latestEstimate` directly instead of going through MCP.
 *
 * The handler is built per request inside `withTokenUser`, so `ctx.userId` is the token row's
 * single tenant and every read is bound to it (§2.2).
 */
import type { createMcpHandler } from "mcp-handler";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { latestEstimate } from "@/lib/server/expenditure";
import { activeTargets, rampTargets } from "@/lib/server/targets";

export type McpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];
export type ToolContext = { userId: string; admin: SupabaseClient };

export const EXPENDITURE_TOOL_SCOPES: Record<"get_expenditure_status" | "get_targets", "read"> = {
  get_expenditure_status: "read",
  get_targets: "read",
};

const json = (value: unknown) => ({ content: [{ type: "text" as const,
  text: JSON.stringify(value, null, 2) }] });

export function registerExpenditureTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_expenditure_status",
    {
      title: "Expenditure status",
      description: "Her advisory expenditure estimate: status, TDEE in kcal, confidence and the reason string. Read-only; it can neither propose nor set a target.",
      inputSchema: z.object({}),
    },
    async () => json(await latestEstimate(ctx.admin, ctx.userId)),
  );

  server.registerTool(
    "get_targets",
    {
      title: "Active targets",
      description: "The calorie and macro targets in force per day type. Falls back to the authored ramp when no profile is effective yet.",
      inputSchema: z.object({}),
    },
    async () => json(await activeTargets(ctx.admin, ctx.userId)
      ?? await rampTargets(ctx.admin, ctx.userId)),
  );
}
```

- [ ] Run: `pnpm test tests/expenditure/mcp-tools.test.ts` — expect PASS (3 tests).
- [ ] Commit: `git add lib/mcp tests/expenditure && git commit -m "feat(mcp): read-only expenditure and targets tools"`

---

## Task 17 — Pull-only sync entities and the client cache

**Files**
- Modify: `lib/sync/types.ts` (L5–7 `Entity`, L10–13 `ENTITIES`), `lib/sync/keys.ts` (L7 `ID_KEYED`), `lib/sync/merge.ts` (L16 `NEVER_MERGED`), `lib/sync/idb.ts` (L12 `DB_VERSION`)
- Create: `lib/estimator-client.ts`
- Test: `tests/targets/sync-entities.test.ts`, `tests/targets/estimator-client.test.ts`

**Interfaces**
- Consumes: `ENTITIES`, `type Entity`, `type SyncOp` (`lib/sync/types.ts`); `enqueue(op, now?)` (`lib/sync/outbox.ts:51`); `NEVER_MERGED` (`lib/sync/merge.ts:16`); `type ExpenditureResponse`, `type ProposalSummary`, `type DecideRequest`, `type DecideResponse`.
- Produces: `Entity` gains `"target_profiles" | "target_proposals"`; `ENTITIES` gains both; `DB_VERSION = 4`; `NEVER_MERGED` gains `target_proposals`; and from `lib/estimator-client.ts`: `EXPENDITURE_CACHE_KEY = "smc:expenditure"`, `PROPOSALS_CACHE_KEY = "smc:proposals"`, `MIN_WEIGH_INS_FOR_TREND = 20`, `PULL_ONLY_ENTITIES`, `class PullOnlyEntityError`, `enqueueGuarded`, `readCache`, `writeCache`, `fetchExpenditure`, `fetchProposals`, `decideProposalOnline`, `shouldMountWeightTrend`.

> **Wave-3 merge note.** Lane L (Phase 3) already raises `DB_VERSION` to 3 and adds four entities to `ENTITIES` (wave-3 contracts §1 and the `lib/sync/idb.ts` line in §5). Rebase onto wave 3 first, keep L's entries, and append Q's two.

- [ ] Write the failing tests:

```ts
// tests/targets/sync-entities.test.ts
import { describe, expect, it } from "vitest";
import { ENTITIES } from "@/lib/sync/types";
import { decodeKey, encodeKey } from "@/lib/sync/keys";
import { MergeRefusedError, mergeEntity, NEVER_MERGED } from "@/lib/sync/merge";
import { DB_VERSION } from "@/lib/sync/idb";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("target_profiles and target_proposals as pull-only entities", () => {
  it("are in ENTITIES so a pulled change row lands in the client store", () => {
    expect(ENTITIES).toContain("target_profiles");
    expect(ENTITIES).toContain("target_proposals");
  });
  it("are uuid-keyed and round-trip", () => {
    for (const e of ["target_profiles", "target_proposals"] as const) {
      expect(encodeKey(e, { id: UUID.toUpperCase() })).toBe(UUID);
      expect(decodeKey(e, UUID)).toEqual({ id: UUID });
    }
  });
  it("are never merged — the server wins outright", () => {
    expect(NEVER_MERGED.has("target_profiles")).toBe(true);
    expect(NEVER_MERGED.has("target_proposals")).toBe(true);
    for (const e of ["target_profiles", "target_proposals"] as const) {
      expect(() => mergeEntity(e, { id: UUID }, { id: UUID }, "2026-09-11T00:00:00.000Z",
        "2026-09-11T00:00:01.000Z")).toThrow(MergeRefusedError);
    }
  });
  it("bumps the IndexedDB version so the two stores are created", () => {
    expect(DB_VERSION).toBe(4);
  });
});
```

```ts
// tests/targets/estimator-client.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const enqueue = vi.fn();
vi.mock("@/lib/sync/outbox", () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));
const {
  decideProposalOnline, EXPENDITURE_CACHE_KEY, enqueueGuarded, fetchExpenditure,
  PullOnlyEntityError, readCache, shouldMountWeightTrend, writeCache,
} = await import("@/lib/estimator-client");

const store = new Map<string, string>();
beforeEach(() => {
  enqueue.mockReset();
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
});

describe("the outbox guard", () => {
  it("refuses to enqueue an op for either pull-only entity", async () => {
    for (const entity of ["target_profiles", "target_proposals"] as const) {
      await expect(enqueueGuarded({ op_id: "o1", entity, entity_id: "x", kind: "update",
        base_rev: 1, payload: {}, client_ts: "2026-09-11T00:00:00.000Z" }))
        .rejects.toBeInstanceOf(PullOnlyEntityError);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("still enqueues an ordinary entity", async () => {
    enqueue.mockResolvedValue({});
    await enqueueGuarded({ op_id: "o1", entity: "water_log", entity_id: "2026-09-11",
      kind: "update", base_rev: 1, payload: {}, client_ts: "2026-09-11T00:00:00.000Z" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("caches", () => {
  it("stamps an as-of date and survives a bad payload", () => {
    writeCache(EXPENDITURE_CACHE_KEY, { status: "estimating" }, "2026-09-11");
    expect(readCache(EXPENDITURE_CACHE_KEY)).toEqual(
      { asOf: "2026-09-11", value: { status: "estimating" } });
    store.set(EXPENDITURE_CACHE_KEY, "{not json");
    expect(readCache(EXPENDITURE_CACHE_KEY)).toBeNull();
  });
  it("falls back to the cache when the fetch fails", async () => {
    writeCache(EXPENDITURE_CACHE_KEY, { status: "estimating" }, "2026-09-10");
    const out = await fetchExpenditure(async () => { throw new Error("offline"); });
    expect(out).toEqual({ asOf: "2026-09-10", value: { status: "estimating" }, stale: true });
  });
});

describe("decideProposalOnline", () => {
  it("refuses offline rather than queueing an approval", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(decideProposalOnline("pr1", "approve")).rejects.toThrow(/connection/i);
  });
});

describe("shouldMountWeightTrend", () => {
  it("mounts only past burn-in with at least 20 weigh-ins (F-091)", () => {
    expect(shouldMountWeightTrend("burn_in", 40)).toBe(false);
    expect(shouldMountWeightTrend("estimating", 19)).toBe(false);
    expect(shouldMountWeightTrend("estimating", 20)).toBe(true);
    expect(shouldMountWeightTrend("held", 25)).toBe(true);
  });
});
```

- [ ] Run: `pnpm test tests/targets/sync-entities.test.ts tests/targets/estimator-client.test.ts` — expect both to fail.
- [ ] Edit `lib/sync/types.ts` — the `Entity` union (L5–7) and `ENTITIES` (L10–13):

```ts
export type Entity =
  | "user_foods" | "user_food_prefs" | "log_entries" | "log_items"
  | "water_log" | "plan_days" | "user_settings" | "gut_log" | "duplicate_groups"
  // Phase 6: pull-only. The server writes both (approve_target_proposal); the client never
  // enqueues an op for either — `lib/estimator-client.ts` refuses, and the SQL `_sync_*` helpers
  // were deliberately not extended, so a hand-crafted op comes back as an error result.
  | "target_profiles" | "target_proposals";

/** The entities that sync on their own. `log_items` ride inside `log_entries.payload.items[]`. */
export const ENTITIES = [
  "user_foods", "user_food_prefs", "log_entries", "water_log",
  "plan_days", "user_settings", "gut_log", "duplicate_groups",
  "target_profiles", "target_proposals",
] as const satisfies readonly Entity[];
```

- [ ] Edit `lib/sync/keys.ts` L7:

```ts
const ID_KEYED = new Set<Entity>(["user_foods", "log_entries", "gut_log", "duplicate_groups",
  "target_profiles", "target_proposals"]);
```

- [ ] Edit `lib/sync/merge.ts` L16:

```ts
/** Server wins outright; the client discards its op and says "targets changed elsewhere".
 *  Phase 6 adds `target_proposals`: a decision made on the other device is the decision. */
export const NEVER_MERGED: ReadonlySet<string> = new Set(["target_profiles", "target_proposals"]);
```

- [ ] Edit `lib/sync/idb.ts` L12: `export const DB_VERSION = 4;` (the `upgrade` loop over `ENTITIES` creates the two new stores; nothing else changes).
- [ ] Write `lib/estimator-client.ts`:

```ts
"use client";

/**
 * Client-side estimator state. Estimate and proposal payloads are cached in `localStorage` with an
 * "as of" stamp so the cards render offline (contracts §3; no IndexedDB store of their own —
 * `lib/sync/idb.ts` already mirrors the pulled rows).
 *
 * Approval is ONLINE ONLY. Targets are never merged (§3.7), so an outbox approval could apply
 * against a profile that has since changed; this is the one place the app refuses to queue.
 */
import { enqueue } from "@/lib/sync/outbox";
import type { Entity, SyncOp } from "@/lib/sync/types";
import type {
  DecideResponse, ExpenditureResponse, ProposalSummary,
} from "@/lib/api-types";

export const EXPENDITURE_CACHE_KEY = "smc:expenditure";
export const PROPOSALS_CACHE_KEY = "smc:proposals";
/** F-091: the trend line needs 20 weigh-ins before it means anything. */
export const MIN_WEIGH_INS_FOR_TREND = 20;

export const PULL_ONLY_ENTITIES: ReadonlySet<Entity> =
  new Set<Entity>(["target_profiles", "target_proposals"]);

export class PullOnlyEntityError extends Error {
  constructor(public readonly entity: Entity) {
    super(`${entity} is pull-only — the server writes it and the client never queues an op`);
    this.name = "PullOnlyEntityError";
  }
}

/** The guard the outbox itself does not carry: Lane Q owns this file, not `lib/sync/outbox.ts`. */
export async function enqueueGuarded(op: SyncOp): Promise<ReturnType<typeof enqueue>> {
  if (PULL_ONLY_ENTITIES.has(op.entity)) throw new PullOnlyEntityError(op.entity);
  return enqueue(op);
}

export type Cached<T> = { asOf: string; value: T };

export function readCache<T>(key: string): Cached<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    return typeof parsed?.asOf === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, value: T, asOf: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ asOf, value } satisfies Cached<T>));
  } catch {
    // A full or disabled store is not a reason to fail the screen.
  }
}

export type Fresh<T> = Cached<T> & { stale: boolean };

async function fetchCached<T>(
  key: string, url: string, fetchFn: typeof fetch = fetch,
): Promise<Fresh<T> | null> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const value = (await res.json()) as T;
    writeCache(key, value, today);
    return { asOf: today, value, stale: false };
  } catch {
    const cached = readCache<T>(key);
    return cached ? { ...cached, stale: true } : null;
  }
}

export function fetchExpenditure(fetchFn: typeof fetch = fetch) {
  return fetchCached<ExpenditureResponse>(EXPENDITURE_CACHE_KEY, "/api/expenditure", fetchFn);
}

export function fetchProposals(fetchFn: typeof fetch = fetch) {
  return fetchCached<ProposalSummary[]>(PROPOSALS_CACHE_KEY, "/api/proposals?status=pending", fetchFn);
}

export async function decideProposalOnline(
  proposalId: string, decision: "approve" | "reject", fetchFn: typeof fetch = fetch,
): Promise<DecideResponse> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("Needs a connection");
  }
  const res = await fetchFn(`/api/proposals/${proposalId}/decide`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, expectedStatus: "pending" }),
  });
  if (!res.ok) throw new Error(`decide failed: ${res.status}`);
  try {
    localStorage.removeItem(PROPOSALS_CACHE_KEY);
  } catch { /* see writeCache */ }
  return (await res.json()) as DecideResponse;
}

/** Spec acceptance criterion 3: no empty state, because the component does not mount. */
export function shouldMountWeightTrend(
  status: ExpenditureResponse["status"], weighInCount: number,
): boolean {
  return status !== "burn_in" && weighInCount >= MIN_WEIGH_INS_FOR_TREND;
}
```

- [ ] Run: `pnpm test tests/targets/sync-entities.test.ts tests/targets/estimator-client.test.ts` — expect PASS (10 tests).
- [ ] Run the whole existing sync suite to prove nothing regressed: `pnpm test lib/sync` — expect PASS.
- [ ] Commit: `git add lib/sync lib/estimator-client.ts tests/targets && git commit -m "feat(sync): target_profiles and target_proposals as pull-only entities with a client guard"`

---

## Task 18 — `EstimatorCard` and `ProposalCard`

**Files**
- Create: `components/EstimatorCard.tsx`, `components/ProposalCard.tsx`
- Test: `tests/expenditure/card-copy.test.ts`

**Interfaces**
- Consumes: `type ExpenditureResponse`, `type ProposalSummary`; `decideProposalOnline`; DESIGN.md utilities `.shell .surface .pill .pill-in .btn-ink .tap .ts` (`app/globals.css:123–235`) and the mockup values below.
- Produces: `confidenceWord`, `CONFIDENCE_FAIR = 0.5`, `CONFIDENCE_GOOD = 0.75`, `estimatorHeadline`, `estimatorDetail` (from `EstimatorCard.tsx`); `deltaSentence` (from `ProposalCard.tsx`); the two default-exported components.

> Design values are copied, not invented: the stat pair (label 12 px/300 `#6B6B6B` over a 28 px/300, `-0.025em`, `line-height: 1` number) is `Main.dc.html:149`; the olive alert card (32 px shell `linear-gradient(180deg,#6b7059,#4f5343 50%,#2f3229)` → 31 px interior `linear-gradient(180deg,#4f5343,#3a3d31)`, `padding: 20px 22px`, 14 px/400 `#e6d8cc` headline over 12 px/300 `rgba(230,216,204,0.72)` body) is `Main.dc.html:79–85`.

- [ ] Write the failing test `tests/expenditure/card-copy.test.ts`:

```ts
// tests/expenditure/card-copy.test.ts
import { describe, expect, it } from "vitest";
import { confidenceWord, estimatorDetail, estimatorHeadline } from "@/components/EstimatorCard";
import { deltaSentence } from "@/components/ProposalCard";
import type { ExpenditureResponse, ProposedTargets } from "@/lib/api-types";

const est = (over: Partial<ExpenditureResponse>): ExpenditureResponse => ({
  status: "estimating", localDate: "2026-09-11", tdeeKcal: 2250, weightTrendKg: 57.4,
  confidence: 0.86, intakeCompleteness: 0.93, qualifiedDays: 19, weighInCount: 18,
  reason: null, engineVersion: "exp-1.0.0", ...over });

describe("confidenceWord", () => {
  it("reads low, fair or good", () => {
    expect([confidenceWord(0.2), confidenceWord(0.5), confidenceWord(0.9)])
      .toEqual(["low", "fair", "good"]);
  });
});

describe("EstimatorCard copy", () => {
  it("counts the days in burn-in and shows no number", () => {
    const e = est({ status: "burn_in", tdeeKcal: null, qualifiedDays: 12,
      reason: "Learning your numbers — 12 of 21 days" });
    expect(estimatorHeadline(e)).toBe("Learning your numbers");
    expect(estimatorDetail(e)).toBe("12 of 21 days");
  });
  it("shows the reason sentence when held", () => {
    const e = est({ status: "held", reason: "3 qualified days in the last 7" });
    expect(estimatorHeadline(e)).toBe("Holding steady");
    expect(estimatorDetail(e)).toBe("3 qualified days in the last 7");
  });
  it("shows the TDEE, the confidence word and the date when estimating", () => {
    expect(estimatorHeadline(est({}))).toBe("2,250 kcal a day");
    expect(estimatorDetail(est({}))).toBe("good confidence · as of 11 Sep 2026");
  });
  it("names the floor conflict and hands the decision to Devin when blocked", () => {
    const e = est({ status: "blocked", reason: "Holding the fat and protein floors needs 210 kcal, above the 150 kcal weekly step. Devin decides." });
    expect(estimatorHeadline(e)).toBe("No proposal this week");
    expect(estimatorDetail(e)).toContain("Devin decides");
  });
});

describe("deltaSentence", () => {
  const proposed = (over: Partial<ProposedTargets> = {}): ProposedTargets => ({
    kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
    deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false, ...over });

  it("states the training number and that protein does not move", () => {
    expect(deltaSentence(proposed()))
      .toBe("Your training days could go to 2,250 — protein unchanged.");
  });
  it("says down when the proposal lowers calories", () => {
    expect(deltaSentence(proposed({ kcalTrain: 2150, deltaKcalTrain: -50 })))
      .toBe("Your training days could come down to 2,150 — protein unchanged.");
  });
  it("says nothing moves when the delta is zero", () => {
    expect(deltaSentence(proposed({ deltaKcalTrain: 0, deltaKcalRest: 0 })))
      .toBe("Your training days stay at 2,250 — protein unchanged.");
  });
});
```

- [ ] Run: `pnpm test tests/expenditure/card-copy.test.ts` — expect the missing-module failure.
- [ ] Write `components/EstimatorCard.tsx`:

```tsx
"use client";

/**
 * The estimator card on Settings, below RampControl (spec "Client changes").
 *
 * Four states, four sentences. Nothing renders a TDEE or a trend in `burn_in` — acceptance
 * criterion 1. Shell and stat typography copied from Main.dc.html:149.
 */
import type { ExpenditureResponse } from "@/lib/api-types";

export const CONFIDENCE_FAIR = 0.5;
export const CONFIDENCE_GOOD = 0.75;

export function confidenceWord(confidence: number): "low" | "fair" | "good" {
  if (confidence < CONFIDENCE_FAIR) return "low";
  if (confidence < CONFIDENCE_GOOD) return "fair";
  return "good";
}

function longDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB",
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function estimatorHeadline(estimate: ExpenditureResponse): string {
  if (estimate.status === "burn_in") return "Learning your numbers";
  if (estimate.status === "held") return "Holding steady";
  if (estimate.status === "blocked") return "No proposal this week";
  return `${(estimate.tdeeKcal ?? 0).toLocaleString("en-US")} kcal a day`;
}

export function estimatorDetail(estimate: ExpenditureResponse): string {
  if (estimate.status === "burn_in") return `${estimate.qualifiedDays} of 21 days`;
  if (estimate.status === "estimating") {
    return `${confidenceWord(estimate.confidence)} confidence · as of ${longDate(estimate.localDate)}`;
  }
  return estimate.reason ?? "";
}

export default function EstimatorCard({ estimate, asOf }: {
  estimate: ExpenditureResponse; asOf?: string;
}) {
  return (
    <section className="shell">
      <div className="surface flex flex-col px-5 py-5">
        <h2 className="ts text-heading-sm font-normal leading-heading-sm tracking-heading-sm text-charcoal">
          What you burn
        </h2>
        <p className="mt-1 text-tiny font-light text-muted">Advisory. It never changes a target on its own.</p>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="ts tabular-nums"
            style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-0.025em", lineHeight: 1 }}>
            {estimatorHeadline(estimate)}
          </span>
          <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
            {estimatorDetail(estimate)}
          </span>
        </div>

        {asOf && (
          <p className="mt-3 text-tiny font-light text-muted">Showing the copy saved on {asOf}.</p>
        )}
      </div>
    </section>
  );
}
```

- [ ] Write `components/ProposalCard.tsx`:

```tsx
"use client";

/**
 * The proposal card on Today, while a pending proposal exists (spec "Client changes").
 * Olive alert shell copied from Main.dc.html:79–85. Both buttons are 44 px; offline they disable
 * with "Needs a connection", because an approval is never queued (§3.7, targets are never merged).
 */
import { useState } from "react";
import { decideProposalOnline } from "@/lib/estimator-client";
import type { ProposalSummary, ProposedTargets } from "@/lib/api-types";

const SHELL: React.CSSProperties = {
  borderRadius: 32, padding: 1,
  background: "linear-gradient(180deg, #6b7059 0%, #4f5343 50%, #2f3229 100%)",
  boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 3px 3px -1.5px rgba(0,0,0,0.06), 0 12px 12px -6px rgba(0,0,0,0.06)",
};
const INNER: React.CSSProperties = {
  borderRadius: 31, background: "linear-gradient(180deg, #4f5343 0%, #3a3d31 100%)",
  boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05), inset 0 -2px 4px rgba(0,0,0,0.5)",
  padding: "20px 22px",
};

export function deltaSentence(proposed: ProposedTargets): string {
  const kcal = proposed.kcalTrain.toLocaleString("en-US");
  if (proposed.deltaKcalTrain === 0) return `Your training days stay at ${kcal} — protein unchanged.`;
  const verb = proposed.deltaKcalTrain > 0 ? "could go to" : "could come down to";
  return `Your training days ${verb} ${kcal} — protein unchanged.`;
}

export default function ProposalCard({ proposal, offline, asOf, onDecided }: {
  proposal: ProposalSummary; offline: boolean; asOf?: string;
  onDecided: (decision: "approve" | "reject") => void;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = offline || busy;

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    try {
      await decideProposalOnline(proposal.id, decision);
      onDecided(decision);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={SHELL}>
      <div style={INNER} className="flex flex-col gap-3">
        <p style={{ margin: 0, fontSize: 14, fontWeight: 400, color: "#e6d8cc",
          textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}>
          {deltaSentence(proposal.proposed)}
        </p>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 300, lineHeight: "19.5px",
          color: "rgba(230,216,204,0.72)" }}>
          Rest days {proposal.proposed.kcalRest.toLocaleString("en-US")} kcal · protein{" "}
          {proposal.proposed.proteinG} g · fat {proposal.proposed.fatG} g · carbs{" "}
          {proposal.proposed.carbG} g. Nothing changes until you tap.
          {asOf ? ` Saved on ${asOf}.` : ""}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" disabled={disabled} onClick={() => decide("approve")}
            className="tap h-11 px-5 text-caption font-normal disabled:opacity-40"
            style={{ borderRadius: 12, background: "#e6d8cc", color: "#2F3229" }}>
            Use these
          </button>
          <button type="button" disabled={disabled} onClick={() => decide("reject")}
            className="tap h-11 px-5 text-caption font-normal disabled:opacity-40"
            style={{ borderRadius: 12, background: "rgba(0,0,0,0.25)", color: "#e6d8cc" }}>
            Keep mine
          </button>
        </div>

        {offline && (
          <p style={{ margin: 0, fontSize: 12, fontWeight: 300, color: "rgba(230,216,204,0.72)" }}>
            Needs a connection
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] Run: `pnpm test tests/expenditure/card-copy.test.ts` — expect PASS (8 tests).
- [ ] `[manual gate]` Phone check (Devin, with `NEXT_PUBLIC_ESTIMATOR_UI=1`): Settings shows one estimator card below "Week N of the build-up" with no TDEE while burn-in lasts; Today shows one proposal card with both buttons at least 44 px tall on a 390 px screen; airplane mode disables both and shows "Needs a connection".
- [ ] Commit: `git add components/EstimatorCard.tsx components/ProposalCard.tsx tests/expenditure && git commit -m "feat(ui): estimator card and proposal card"`

---

## Task 19 — `TargetModeSheet` and `WeightTrend`

**Files**
- Create: `components/TargetModeSheet.tsx`, `components/WeightTrend.tsx`
- Test: `tests/targets/target-mode-preview.test.ts`

**Interfaces**
- Consumes: `Sheet` (`components/Sheet.tsx` — props `{ title, subtitle?, onClose, children, footer? }`); `Stepper` (`components/Stepper.tsx` — props `{ label, value, step, unit?, onChange, disabled?, helperText? }`); `percentToGrams`, `applyFloors`, `validatePercentProfile`, `type MacroFloors`, `type MacroPercents`; `type TargetsRequest`, `type TargetsResponse`.
- Consumes **from Lane P** (contracts §2): `Sparkline` — `export default function Sparkline(props: { points: (number|null)[]; width?: number; height?: number; stroke?: string; label: string })`, with `null` points rendered as a gap, never a zero. `WeightTrend` lands **after** Lane P: rebase onto the landed `main` (order P → Q) before writing it. Its mount rule is `shouldMountWeightTrend`, which is already tested in Task 17 without P.
- Produces: `previewGrams(kcalTrain, kcalRest, pct, floors)`, default-exported `TargetModeSheet`; `WEIGHT_LB_PER_KG = 2.2046226218`, `toPounds`, default-exported `WeightTrend`.

- [ ] Write the failing test `tests/targets/target-mode-preview.test.ts`:

```ts
// tests/targets/target-mode-preview.test.ts
import { describe, expect, it } from "vitest";
import { previewGrams } from "@/components/TargetModeSheet";
import { toPounds, WEIGHT_LB_PER_KG } from "@/components/WeightTrend";
import { CARB_G_MIN, FAT_G_MIN, KCAL_MIN, type MacroFloors } from "@/lib/targets/percent";

const FLOORS: MacroFloors = { kcalMin: KCAL_MIN, proteinGMin: 135, fatGMin: FAT_G_MIN, carbGMin: CARB_G_MIN };

describe("previewGrams", () => {
  it("shows the grams each day type produces, from the same function the server uses", () => {
    const out = previewGrams(2200, 1750, { proteinPct: 31, fatPct: 30, carbPct: 39 }, FLOORS);
    expect(out.ok).toBe(true);
    expect(out.training.proteinG).toBeGreaterThanOrEqual(135);
    expect(out.rest.proteinG).toBeGreaterThanOrEqual(135);
    expect(Math.abs(4 * out.training.proteinG + 9 * out.training.fatG + 4 * out.training.carbG - 2200))
      .toBeLessThanOrEqual(10);
  });

  it("reports the floor failure and the minimum percentage instead of silently fixing it", () => {
    const out = previewGrams(2200, 1750, { proteinPct: 20, fatPct: 30, carbPct: 50 }, FLOORS);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("protein_below_floor");
    expect(out.minProteinPct).toBeCloseTo(30.86, 2);
  });

  it("reports a split that does not sum to 100", () => {
    expect(previewGrams(2200, 1750, { proteinPct: 30, fatPct: 30, carbPct: 39 }, FLOORS).error)
      .toBe("percent_sum");
  });
});

describe("toPounds", () => {
  it("converts kilograms for display and keeps nulls as gaps", () => {
    expect(WEIGHT_LB_PER_KG).toBeCloseTo(2.2046226218, 10);
    expect(toPounds([57.6, null, 57.4])).toEqual([127, null, 126.5]);
  });
});
```

- [ ] Run: `pnpm test tests/targets/target-mode-preview.test.ts` — expect the missing-module failure.
- [ ] Write `components/TargetModeSheet.tsx`:

```tsx
"use client";

/**
 * Grams / percent toggle plus three steppers, opened from Settings (spec "Client changes").
 * In percent mode it shows the percentages she entered AND the grams they produce for a training
 * day and a rest day, live, from the same pure functions the server uses for authority.
 */
import { useState } from "react";
import Sheet from "@/components/Sheet";
import Stepper from "@/components/Stepper";
import {
  applyFloors, percentToGrams, validatePercentProfile,
  type GramTargets, type MacroFloors, type MacroPercents,
} from "@/lib/targets/percent";
import type { TargetsRequest } from "@/lib/api-types";

export type Preview =
  | { ok: true; training: GramTargets; rest: GramTargets }
  | { ok: false; error: string; minProteinPct: number; minFatPct: number;
      training: GramTargets; rest: GramTargets };

export function previewGrams(
  kcalTrain: number, kcalRest: number, pct: MacroPercents, floors: MacroFloors,
): Preview {
  const training = applyFloors(kcalTrain, percentToGrams(kcalTrain, pct), floors).grams;
  const rest = applyFloors(kcalRest, percentToGrams(kcalRest, pct), floors).grams;
  const check = validatePercentProfile(pct, kcalTrain, kcalRest, floors);
  return check.ok
    ? { ok: true, training, rest }
    : { ok: false, error: check.error, minProteinPct: check.minProteinPct,
        minFatPct: check.minFatPct, training, rest };
}

const line = (label: string, g: GramTargets) =>
  `${label}: ${g.proteinG} g protein · ${g.fatG} g fat · ${g.carbG} g carbs`;

export default function TargetModeSheet({ initial, floors, onClose, onSave }: {
  initial: { mode: "grams" | "percent"; kcalTrain: number; kcalRest: number;
    grams: GramTargets; percent: MacroPercents };
  floors: MacroFloors;
  onClose: () => void;
  onSave: (req: TargetsRequest) => void;
}) {
  const [mode, setMode] = useState(initial.mode);
  const [pct, setPct] = useState<MacroPercents>(initial.percent);
  const [grams, setGrams] = useState<GramTargets>(initial.grams);

  const preview = previewGrams(initial.kcalTrain, initial.kcalRest, pct, floors);
  const today = new Date().toISOString().slice(0, 10);

  function save() {
    onSave(mode === "percent"
      ? { mode, effectiveFrom: today, kcalTrain: initial.kcalTrain,
          kcalRest: initial.kcalRest, percent: pct }
      : { mode, effectiveFrom: today, kcalTrain: initial.kcalTrain,
          kcalRest: initial.kcalRest, grams });
  }

  return (
    <Sheet title="Targets" subtitle="Grams, or percentages of the day" onClose={onClose}
      footer={
        <button type="button" onClick={save} disabled={mode === "percent" && !preview.ok}
          className="btn-ink tap h-11 w-full text-caption font-normal disabled:opacity-40">
          Save targets
        </button>
      }>
      <div className="flex flex-col gap-5">
        <div className="pill inline-flex self-start">
          <div className="pill-in flex items-center">
            {(["grams", "percent"] as const).map((option) => (
              <button key={option} type="button" onClick={() => setMode(option)}
                className="tap px-5 text-tiny"
                style={{ height: 44, borderRadius: 9999, fontWeight: mode === option ? 400 : 300,
                  color: mode === option ? "#2B2B2B" : "#6B6B6B" }}>
                {option === "grams" ? "Grams" : "Percent"}
              </button>
            ))}
          </div>
        </div>

        {mode === "percent" ? (
          <>
            <Stepper label="Protein" value={pct.proteinPct} step={1} unit="%"
              onChange={(v) => setPct({ ...pct, proteinPct: v })} />
            <Stepper label="Fat" value={pct.fatPct} step={1} unit="%"
              onChange={(v) => setPct({ ...pct, fatPct: v })} />
            <Stepper label="Carbs" value={pct.carbPct} step={1} unit="%"
              onChange={(v) => setPct({ ...pct, carbPct: v })} />
          </>
        ) : (
          <>
            <Stepper label="Protein" value={grams.proteinG} step={5} unit="g"
              onChange={(v) => setGrams({ ...grams, proteinG: v })} />
            <Stepper label="Fat" value={grams.fatG} step={5} unit="g"
              onChange={(v) => setGrams({ ...grams, fatG: v })} />
            <Stepper label="Carbs" value={grams.carbG} step={5} unit="g"
              onChange={(v) => setGrams({ ...grams, carbG: v })} />
          </>
        )}

        {mode === "percent" && (
          <div className="well flex flex-col gap-1 px-4 py-3">
            <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
              {line("Training day", preview.training)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
              {line("Rest day", preview.rest)}
            </span>
            {!preview.ok && (
              <span style={{ fontSize: 12, fontWeight: 400, color: "#2B2B2B" }}>
                {preview.error === "percent_sum"
                  ? "The three percentages must add up to 100."
                  : preview.error === "protein_below_floor"
                    ? `Protein needs at least ${preview.minProteinPct} %.`
                    : `Fat needs at least ${preview.minFatPct} %.`}
              </span>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
```

- [ ] `[after Lane P lands — rebase onto main first]` Write `components/WeightTrend.tsx`:

```tsx
"use client";

/**
 * The gated weight-trend line on Settings. It renders ONLY when status has left `burn_in` and at
 * least 20 weigh-ins exist (F-091), so it has no empty state: it does not mount. The caller checks
 * `shouldMountWeightTrend`; this component checks again so a future caller cannot bypass the gate.
 *
 * Storage stays kilograms; the screen reads pounds (contracts §2, ASSUMED). `null` is a gap in the
 * line, never a zero — Sparkline (Lane P, contracts §2) renders it as one.
 */
import Sparkline from "@/components/Sparkline";
import { shouldMountWeightTrend } from "@/lib/estimator-client";
import type { ExpenditureResponse } from "@/lib/api-types";

export const WEIGHT_LB_PER_KG = 2.2046226218;

export function toPounds(points: (number | null)[]): (number | null)[] {
  return points.map((kg) => (kg === null ? null : Math.round(kg * WEIGHT_LB_PER_KG * 10) / 10));
}

export default function WeightTrend({ status, weighInCount, trendKg }: {
  status: ExpenditureResponse["status"]; weighInCount: number; trendKg: (number | null)[];
}) {
  if (!shouldMountWeightTrend(status, weighInCount)) return null;
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 px-5 py-5">
        <h2 className="ts text-heading-sm font-normal leading-heading-sm tracking-heading-sm text-charcoal">
          Weight trend
        </h2>
        <Sparkline points={toPounds(trendKg)} label="Weight trend in pounds" stroke="#4F5343" />
        <p className="text-tiny font-light text-muted">
          A 20-day average, in pounds. Day-to-day water is smoothed out.
        </p>
      </div>
    </section>
  );
}
```

- [ ] Run: `pnpm test tests/targets/target-mode-preview.test.ts` — expect PASS (4 tests).
- [ ] `[manual gate]` Phone check: open the sheet from Settings, switch to percent, step protein down until the floor message names a minimum percentage, and confirm the two grams lines update on every tap.
- [ ] Commit: `git add components/TargetModeSheet.tsx components/WeightTrend.tsx tests/targets && git commit -m "feat(ui): percent target sheet with a live grams preview and the gated weight trend"`

---

## Task 20 — Branch integration suite

**Files**
- Create: `tests/expenditure/job-runs-fixture.ts`, `tests/expenditure/branch.test.ts`, `tests/proposals/branch-decide.test.ts`, `tests/targets/branch-cross-user.test.ts`
- Test: the three `branch*` files themselves

**Interfaces**
- Consumes: `HAS_BRANCH`, `createTestUsers`, `adminClient`, `userClient`, `ensureUser`, `resetUser` (`tests/helpers/supabase.ts`); the migration of Task 1; `POST` of both job routes; `decideProposal`; `activeTargets`.
- Produces: nothing importable — these are the `[needs branch]` gates for spec acceptance criteria 5, 6, 7, 9, 10, 11, 13.

- [ ] Write `tests/expenditure/job-runs-fixture.ts`:

```ts
/**
 * `job_runs` belongs to Lane P's `20260926000000_phase5_oura_oauth.sql`. When Q's branch is pushed
 * before P has landed, the table is absent; Q's own migration creates it with `if not exists`, and
 * this fixture is the belt for a branch that was pushed from an older checkout. It needs psql and
 * SUPABASE_TEST_DB_URL and is a no-op without them, so CI stays green.
 */
import { execFileSync } from "node:child_process";

const DDL = `create table if not exists job_runs (job text not null, run_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));`;

export function ensureJobRuns(): void {
  const url = process.env.SUPABASE_TEST_DB_URL;
  if (!url) return;
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", DDL], { stdio: "pipe" });
}
```

- [ ] Write `tests/expenditure/branch.test.ts`:

```ts
// tests/expenditure/branch.test.ts  — [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { ensureJobRuns } from "./job-runs-fixture";

const run = HAS_BRANCH ? describe : describe.skip;

run("the weekly job on a real branch", () => {
  let userId = "";
  const admin = adminClient();

  beforeAll(async () => {
    ensureJobRuns();
    const users = await createTestUsers();
    userId = users.a.userId;
    await resetUser(userId);
    process.env.CRON_SECRET = "branch-secret";
    process.env.ESTIMATOR_ENABLED = "1";
  });

  async function seedEstimating(weekStart: string) {
    await admin.rpc("upsert_expenditure_estimate", { p_user_id: userId, p_row: {
      local_date: weekStart, status: "estimating", tdee_kcal: 2250, weight_trend_kg: 57.4,
      intake_avg_kcal: 2200, intake_completeness: 1, qualified_days: 21, weigh_in_count: 21,
      confidence: 1, reason: null, engine_version: "exp-1.0.0" } });
  }

  it("upserts one estimate per user and local date (acceptance criterion 5's sibling)", async () => {
    await seedEstimating("2026-09-14");
    await seedEstimating("2026-09-14");
    const { data } = await admin.from("expenditure_estimates").select("id")
      .eq("user_id", userId).eq("local_date", "2026-09-14");
    expect(data).toHaveLength(1);
  });

  it("refuses a browser insert into expenditure_estimates (acceptance criterion 13)", async () => {
    const users = await createTestUsers();
    const { error } = await users.a.client.from("expenditure_estimates")
      .insert({ user_id: userId, local_date: "2026-09-15", status: "estimating",
        engine_version: "exp-1.0.0" });
    expect(error).not.toBeNull();
  });

  it("refuses the service-role-only estimate upsert from a browser session", async () => {
    const users = await createTestUsers();
    const { error } = await users.a.client.rpc("upsert_expenditure_estimate",
      { p_user_id: userId, p_row: { local_date: "2026-09-16", status: "estimating",
        engine_version: "exp-1.0.0" } });
    expect(error).not.toBeNull();
  });

  it("writes exactly one proposal per user and week (acceptance criterion 5)", async () => {
    const row = { user_id: userId, week_start: "2026-09-21", status: "pending",
      proposed: { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
        deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false } };
    expect((await admin.from("target_proposals").insert(row)).error).toBeNull();
    expect((await admin.from("target_proposals").insert(row)).error?.code).toBe("23505");
  });
});
```

- [ ] Write `tests/proposals/branch-decide.test.ts`:

```ts
// tests/proposals/branch-decide.test.ts  — [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { decideProposal, ProposalConflictError } from "@/lib/server/proposals";
import { activeTargets } from "@/lib/server/targets";

const run = HAS_BRANCH ? describe : describe.skip;

run("approve_target_proposal on a real branch", () => {
  const admin = adminClient();
  let users: Awaited<ReturnType<typeof createTestUsers>>;
  let proposalId = "";

  const PROPOSED = { kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
    deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false };

  beforeAll(async () => {
    users = await createTestUsers();
    await resetUser(users.a.userId);
    await resetUser(users.b.userId);
    await admin.from("target_profiles").insert({ user_id: users.a.userId,
      effective_from: "2026-09-01", kcal_train: 2200, kcal_rest: 1750, authored_by: "user",
      mode: "grams", protein_g: 135, fat_g: 85, carb_g: 200, protein_g_min: 135 });
    const { data } = await admin.from("target_proposals").insert({ user_id: users.a.userId,
      week_start: "2026-09-28", status: "pending", proposed: PROPOSED }).select("id").single();
    proposalId = data?.id as string;
  });

  it("approves in one transaction: one profile, two change_log rows (criteria 6 and 7)", async () => {
    const before = await activeTargets(users.a.client, users.a.userId);
    expect(before?.resolved.training.kcal).toBe(2200);      // criterion 6: unchanged until approval

    const out = await decideProposal(users.a.client, users.a.userId, proposalId,
      { decision: "approve", expectedStatus: "pending" });
    expect(out.status).toBe("approved");

    const { data: profiles } = await admin.from("target_profiles")
      .select("id, authored_by").eq("user_id", users.a.userId).eq("authored_by", "engine_proposal");
    expect(profiles).toHaveLength(1);

    const { data: log } = await admin.from("change_log").select("entity, seq")
      .eq("user_id", users.a.userId).in("entity", ["target_profiles", "target_proposals"])
      .order("seq", { ascending: true });
    expect(log?.map((r) => r.entity)).toEqual(["target_profiles", "target_proposals"]);
    expect((log?.[1].seq as number) - (log?.[0].seq as number)).toBe(1);
  });

  it("409s on a second approve and writes nothing more (criterion 7)", async () => {
    await expect(decideProposal(users.a.client, users.a.userId, proposalId,
      { decision: "approve", expectedStatus: "pending" }))
      .rejects.toBeInstanceOf(ProposalConflictError);
    const { data } = await admin.from("target_profiles").select("id")
      .eq("user_id", users.a.userId).eq("authored_by", "engine_proposal");
    expect(data).toHaveLength(1);
  });

  it("404s for another user's proposal id and changes nothing (criterion 13)", async () => {
    await expect(decideProposal(users.b.client, users.b.userId, proposalId,
      { decision: "approve", expectedStatus: "pending" })).rejects.toMatchObject({ status: 404 });
    const { data } = await admin.from("target_profiles").select("id").eq("user_id", users.b.userId);
    expect(data).toHaveLength(0);
  });

  it("changes what GET /api/targets returns and nothing else", async () => {
    const after = await activeTargets(users.a.client, users.a.userId);
    expect(after?.resolved.training.kcal).toBe(2250);
    expect(after?.resolved.training.protein).toBe(135);      // criterion 8: protein never moves
  });
});
```

- [ ] Write `tests/targets/branch-cross-user.test.ts`:

```ts
// tests/targets/branch-cross-user.test.ts  — [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { authorTargets, FloorViolationError } from "@/lib/server/targets";

const run = HAS_BRANCH ? describe : describe.skip;

run("cross-user denial and percent authority on a real branch", () => {
  const admin = adminClient();
  let users: Awaited<ReturnType<typeof createTestUsers>>;

  beforeAll(async () => {
    users = await createTestUsers();
    await resetUser(users.a.userId);
    await resetUser(users.b.userId);
    await admin.from("expenditure_estimates").insert({ user_id: users.a.userId,
      local_date: "2026-09-11", status: "estimating", tdee_kcal: 2250, confidence: 1,
      engine_version: "exp-1.0.0" });
    await admin.from("target_proposals").insert({ user_id: users.a.userId,
      week_start: "2026-10-05", status: "pending", proposed: {} });
  });

  it("shows user B nothing on either estimator table (criterion 13)", async () => {
    for (const table of ["expenditure_estimates", "target_proposals"]) {
      const { data } = await users.b.client.from(table).select("id");
      expect(data).toEqual([]);
    }
  });

  it("refuses user B's approve_target_proposal against user A's id", async () => {
    const { data, error } = await users.b.client.rpc("approve_target_proposal",
      { p_user_id: users.a.userId, p_proposal_id: "00000000-0000-0000-0000-000000000001" });
    expect(error ?? data).not.toEqual({ status: "approved" });
  });

  it("round-trips a percent profile server-side (criteria 10 and 11)", async () => {
    const out = await authorTargets(users.a.client, users.a.userId, { mode: "percent",
      effectiveFrom: "2026-09-14", kcalTrain: 2200, kcalRest: 1750,
      percent: { proteinPct: 31, fatPct: 30, carbPct: 39 } });
    const t = out.resolved.training;
    expect(Math.abs(4 * t.protein + 9 * t.fat + 4 * t.carbs - t.kcal)).toBeLessThanOrEqual(10);

    await expect(authorTargets(users.a.client, users.a.userId, { mode: "percent",
      effectiveFrom: "2026-09-15", kcalTrain: 2200, kcalRest: 1750,
      percent: { proteinPct: 40, fatPct: 20, carbPct: 40 } }))
      .rejects.toBeInstanceOf(FloorViolationError);
  });

  it("recomputes the floors even when the client sent post-floor numbers", async () => {
    await authorTargets(users.a.client, users.a.userId, { mode: "grams",
      effectiveFrom: "2026-09-16", kcalTrain: 2200, kcalRest: 1750,
      grams: { proteinG: 90, fatG: 30, carbG: 400 } });
    const { data } = await admin.from("target_profiles").select("protein_g, fat_g")
      .eq("user_id", users.a.userId).eq("effective_from", "2026-09-16").single();
    expect(Number(data?.protein_g)).toBeGreaterThanOrEqual(135);
    expect(Number(data?.fat_g)).toBeGreaterThanOrEqual(50);
  });
});
```

- [ ] `[needs branch]` Run (skip condition: `SUPABASE_TEST_URL` unset, in which case every `describe` self-skips and the command still exits 0): `pnpm test:integration tests/expenditure/branch.test.ts tests/proposals/branch-decide.test.ts tests/targets/branch-cross-user.test.ts` — expect PASS (16 tests) on a branch, "skipped" without one.
- [ ] Commit: `git add tests && git commit -m "test(estimator): branch integration suite for approval, idempotency and cross-user denial"`

---

## Lane exit gate

Run once, on the rebased branch, before the PR — targeted, never the full suite twice (AGENTS.md "CI and branches"):

- [ ] `pnpm test tests/expenditure tests/targets tests/proposals lib/sync` — every Lane Q suite plus the untouched sync suites, green.
- [ ] `pnpm lint` and `pnpm exec tsc --noEmit` — clean.
- [ ] `pnpm build` — clean (this is what proves the Lane P imports in Tasks 15 and 19 resolve on the rebased tree).
- [ ] `pnpm exec tsx scripts/backtest-estimator.ts` — the exit record regenerates and matches the committed `docs/estimator-backtest-<date>.md`.

Measured gates, reported in the PR body, never lowered (contracts §7, spec "Acceptance criteria"):

| # | Gate | Where it is measured |
|---|---|---|
| 1–3 | burn-in shows no number; calendar time never ends it; the trend does not mount | `tests/expenditure/expenditure.test.ts`, `tests/targets/estimator-client.test.ts` |
| 4 | the three §4.3 backtests at their stated bounds + the committed table | `tests/expenditure/backtest.test.ts`, `docs/estimator-backtest-<date>.md` |
| 5 | one proposal per user-week | `tests/expenditure/jobs.test.ts`, `tests/expenditure/branch.test.ts` |
| 6–7 | approve is one transaction, 409 on a repeat | `tests/proposals/branch-decide.test.ts` |
| 8–9 | protein frozen, fat ≥ 50 g, kcal ≥ 1650, blocked above the step cap | `tests/proposals/build-proposal.test.ts` |
| 10–11 | percent round trip, 422 naming the minimum percentage | `tests/targets/percent.test.ts`, `tests/targets/branch-cross-user.test.ts` |
| 12 | `engine_version` on every row; a changed constant fails a test | `tests/expenditure/constants.test.ts` |
| 13 | cross-user denial on both tables and the function | `tests/targets/branch-cross-user.test.ts` |
| 14 | offline card from cache with an "as of" date, both buttons disabled | `tests/targets/estimator-client.test.ts` + the Task 18 `[manual gate]` |

PR body carries: the backtest table, the `[needs branch]` run output, and the two `[manual gate]` results. `zs-land` is **not** run by this lane — the wave-4 land order is P → Q → R, then the integration branch (contracts §8).

## Hand-off to integration

Three integration-stage files change. Lane Q writes none of them; these are the exact diffs.

**1. `app/api/mcp/route.ts`** — inside the restructured `withTokenUser` handler (contracts §5), add the registration and merge the scope map:

```ts
import { EXPENDITURE_TOOL_SCOPES, registerExpenditureTools } from "@/lib/mcp/expenditure-tools";

// where the per-request server is built, alongside registerHealthTools and registerCoachTools:
registerExpenditureTools(server, { userId: ctx.userId, admin });

// and in scopeForBody, replacing the WRITE_TOOLS-only lookup:
const TOOL_SCOPES: Record<string, "read" | "log:write" | "constraints:write"> = {
  ...Object.fromEntries([...WRITE_TOOLS].map((name) => [name, "log:write" as const])),
  ...HEALTH_TOOL_SCOPES,
  ...EXPENDITURE_TOOL_SCOPES,   // get_expenditure_status: "read", get_targets: "read"
  ...COACH_TOOL_SCOPES,
};
```

**2. `vercel.json`** — two cron lines next to wave 3's `media-sweep`, in UTC for America/New_York (DST drift accepted, contracts §1):

```json
{ "path": "/api/jobs/estimate", "schedule": "0 7 * * *" },
{ "path": "/api/jobs/weekly-proposal", "schedule": "0 1 * * 1" }
```

`0 7 * * *` is 03:00 EDT nightly; `0 1 * * 1` is Monday 01:00 UTC, which is **Sunday 21:00 EDT** — Q's proposal job runs before R's `weekly-review` at 21:30, as contracts §4 requires.

**3. `app/settings/page.tsx`** — the estimator mounts, ≤ 15 lines, directly below `RampControl`:

```tsx
{process.env.NEXT_PUBLIC_ESTIMATOR_UI && estimate && (
  <>
    <EstimatorCard estimate={estimate.value} asOf={estimate.stale ? estimate.asOf : undefined} />
    <button type="button" onClick={() => setTargetSheetOpen(true)}
      className="shell tap w-full text-left">
      <span className="surface flex h-14 items-center px-5 text-caption text-charcoal">
        Targets — grams or percent
      </span>
    </button>
    <WeightTrend status={estimate.value.status} weighInCount={estimate.value.weighInCount}
      trendKg={trendPoints} />
  </>
)}
{targetSheetOpen && (
  <TargetModeSheet initial={targetSheetInitial} floors={floors}
    onClose={() => setTargetSheetOpen(false)} onSave={saveTargets} />
)}
```

**4. `app/page.tsx`** — the proposal card on Today, ≤ 15 lines, above the Plan section:

```tsx
{process.env.NEXT_PUBLIC_ESTIMATOR_UI && pendingProposal && (
  <ProposalCard
    proposal={pendingProposal.value[0]}
    offline={pendingProposal.stale}
    asOf={pendingProposal.stale ? pendingProposal.asOf : undefined}
    onDecided={() => setPendingProposal(null)}
  />
)}
```

Both screens get their data from `fetchExpenditure()` and `fetchProposals()` (`lib/estimator-client.ts`), which already fall back to the `localStorage` cache and flag `stale`; `trendPoints` comes from Lane P's `weighInsKg` read through `/api/health/daily`, converted by `WeightTrend`.

## Open questions

1. **Burn-in's three windows.** §4.3 lists "≥ 21 qualified days, ≥ 12 weigh-ins, ≥ 15 complete intake days" without naming a window for any of them, and 15 > 14 rules out the estimator window for the third. This plan reads them as: 21 qualified days **lifetime** (which is what makes acceptance criterion 2 true), 12 weighed days **in the last 21**, 15 qualified days **in the last 21**. Each gate then bites for a different reason. Devin confirms, or names different windows; the reading is a comment in `lib/expenditure.ts` and three constants, so a change is one edit and one test.
2. **`tdeeKcal` while `held`.** The spec says `tdeeKcal` is null only in `burn_in`, and claim 2 says under-logging must not lower the number. This plan returns the **previous** value (the prior, rounded) while held, so the card keeps showing what it last knew. The alternative — null while held — would blank the card the moment she misses three days, which reads as a fault.
3. **The ±0.8 kg cycle against the 5 % bound (arithmetic, not opinion).** With α = 2/21 the EMA's gain at a 28-day period is ≈ 0.41, so a ±0.8 kg fluid cycle moves the trend ≈ ±0.33 kg; `trend[t]` and `trend[t−14]` are exactly antiphase at that period, so their difference reaches ≈ 0.65 kg, i.e. ≈ 359 kcal/day of apparent imbalance. The ±10 % prior clamp holds the reported number to ≈ ±213 kcal, which is **≈ 10 %, not ≤ 5 %**, at full confidence. The water swing passes easily (its 1.5 kg day is 2.60 % of 57.6 kg and the outlier rule holds it out, leaving ≈ 1.3 %). Task 7 measures both and the test is written at 5 % as §4.3 states it. If the cycle misses, record the measured figure and raise it — the honest fixes are a tighter prior clamp, a second smoothing stage, or a restated claim, and all three are contract changes, not a tuned constant in this lane.
4. **Approver.** Sasha-only, per contracts §3 (ASSUMED, spec open question 1). `decided_by` is her id. Devin approving needs a grant model that does not exist; nothing here blocks adding one later, because `approve_target_proposal` takes `p_user_id` explicitly.
5. **The job's time zone.** `user_settings` has no tz column, so both jobs use `DEFAULT_TZ = "America/New_York"` for the estimate's `local_date` and the week key. `log_entries.tz` carries a real per-entry zone; if Devin wants the job to follow it, the change is one query in `localDateIn`'s caller. Flagged because a DST week shifts the cron by an hour, which contracts §1 already accepts.
6. **One gram set, two day types.** `target_profiles` stores a single `protein_g` / `fat_g` / `carb_g` triple (architecture §3.4's DDL), so protein and fat are held across day types and carbohydrate carries the difference. The authored ramp in `targets.md` §3 differs: fat is 95 g training and 85 g rest at stage 3. An approved profile therefore cannot express that split. Either the ramp's fat difference is noise worth dropping, or §3.4 needs a second gram set — Devin decides before the first real proposal.
7. **Confidence words.** `low < 0.5 ≤ fair < 0.75 ≤ good` is this plan's choice; the spec says only "low / fair / good". Two named constants in `components/EstimatorCard.tsx`, one test.
8. **`qualified_days` / `weigh_in_count` columns.** Task 1 adds them because the wire type carries counts the Phase 0 table cannot store. That is a contracts §3 addition and lands as its own `docs: phase-5-7 contract change` commit before Task 1's own.
