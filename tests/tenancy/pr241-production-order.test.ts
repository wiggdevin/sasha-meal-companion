/**
 * PR #241 ships 20261028090000_body_fat_provenance and 20261029090000_rate_goals. Both restate the
 * SECURITY DEFINER `_sync_upsert`, and both sort BEFORE 20261103090000 (PR #249: revoke EXECUTE
 * from `authenticated`, caller guard in the body) and 20261103090100 (PR #250: same-owner
 * triggers). Production already has the two 20261103 migrations, so it applies the PR's two
 * AFTER them. A fresh database (CI, `supabase db reset`) applies them in version order.
 *
 * This suite proves the production order is safe: starting from the state production had before
 * PR #249 (authenticated could execute the internals), it applies
 *   20261103090000 → 20261103090100 → 20261028090000 → 20261029090000
 * in one transaction, checks the result, and rolls back. The database is first stepped back with
 * the down files, including any later meal-layout sync patch, so the suite works on a database
 * built either way.
 *
 * What it proves is the end state and behaviour of that sequence: grants, guard, triggers,
 * policies, a cross-account refusal and a trend-weight approval. It does not model the runner's
 * per-file commits (scripts/apply-migrations.py); none of the checked properties depends on where
 * a transaction boundary falls, since each file is self-contained (review r2).
 */
// Refuses any non-local database before anything else runs (PR #247 review r9).
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const up = (name: string) => read(`supabase/migrations/${name}.sql`);
const down = (name: string) => read(`supabase/migrations/down/${name}.down.sql`);
const sqlOnly = (text: string) =>
  text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const GUARD = "20261103090000_sync_internals_revoke_authenticated";
const SAME_OWNER = "20261103090100_same_owner_references";
const BODY_FAT = "20261028090000_body_fat_provenance";
const RATE_GOALS = "20261029090000_rate_goals";
const MEAL_LAYOUT = "20261125090000_meal_layout";
/** Phase 18 W5: extends the same sync branch after the meal-layout patch. */
const PROFILE_SYNC = "20261217090200_profile_sync_cuisines_country";
/**
 * UI-NEEDS SPROUT-CARE: the mascot migration splices text into the middle of two of
 * PROFILE_SYNC's own five anchors (the insert column list and the country_code SET clause), so
 * it must come off before PROFILE_SYNC's down can match those anchors verbatim. Two files: the
 * validate step (a no-op down) and the real one.
 */
const MASCOT = "20261225090000_user_settings_mascot";
const MASCOT_VALIDATE = "20261225090010_user_settings_mascot_validate";
/** UI makeover W3: patches the mascot patch's own text, so it comes off before the mascot does. */
const COMPANIONS = "20270107090000_user_settings_companions_hidden";
const COMPANIONS_VALIDATE = "20270107090100_user_settings_companions_hidden_validate";

const INTERNALS = [
  "_sync_current(uuid, text, text)",
  "_sync_upsert(uuid, text, text, jsonb, integer)",
  "_sync_tombstone(uuid, text, text, text, integer)",
];

describe("PR #241 migrations keep the PR #249 guard (static)", () => {
  for (const name of [BODY_FAT, RATE_GOALS]) {
    const UP = sqlOnly(up(name));
    it(`${name} revokes authenticated after the guard and grants no client role`, () => {
      const revoke = "revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer) "
        + "from public, anon, authenticated;";
      expect(UP).toContain(revoke);
      expect(UP).toContain(
        "grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;");
      // No grant of it to a client role, and the revoke follows the guard block.
      expect(UP).not.toMatch(/grant execute on function (public\.)?_sync_upsert[^;]*(authenticated|anon|public)/);
      expect(UP.lastIndexOf(revoke)).toBeGreaterThan(UP.lastIndexOf("p9_sync_caller_guard"));
    });

    it(`${name} writes the caller guard into _sync_upsert when it is missing, like ${GUARD}`, () => {
      expect(UP).toContain("perform _sync_assert_caller(p_user_id); -- p9_sync_caller_guard");
      expect(UP).toMatch(/position\('p9_sync_caller_guard' in definition\) = 0/);
    });
  }
});

/** Whether each migration is in the database now, read from the catalog. */
function appliedState() {
  const out = runSql([
    "select 'body_fat:' || exists (select 1 from information_schema.columns where table_schema = "
      + "'public' and table_name = 'user_settings' and column_name = 'body_fat_source');",
    "select 'rate_goals:' || exists (select 1 from information_schema.columns where table_schema = "
      + "'public' and table_name = 'user_settings' and column_name = 'goal_rate_bp_week');",
    "select 'meal_layout:' || exists (select 1 from information_schema.columns where table_schema = "
      + "'public' and table_name = 'user_settings' and column_name = 'meals_per_day');",
    "select 'guard:' || (position('p9_sync_caller_guard' in pg_get_functiondef("
      + "'public._sync_current(uuid,text,text)'::regprocedure)) > 0);",
    "select 'same_owner:' || exists (select 1 from pg_trigger where tgname = 'same_owner');",
    "select 'profile_sync:' || (position('cuisines' in pg_get_functiondef("
      + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)) > 0);",
    "select 'mascot:' || (position('mascot' in pg_get_functiondef("
      + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)) > 0);",
    "select 'companions:' || (position('companions_hidden' in pg_get_functiondef("
      + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)) > 0);",
  ].join("\n")).split("\n");
  const flag = (key: string) => out.includes(`${key}:true`);
  return { bodyFat: flag("body_fat"), rateGoals: flag("rate_goals"), mealLayout: flag("meal_layout"), guard: flag("guard"),
    sameOwner: flag("same_owner"), profileSync: flag("profile_sync"), mascot: flag("mascot"),
    companions: flag("companions") };
}

describe.skipIf(!(HAS_DB && HAS_BRANCH))("PR #241 applied in production order, after PR #249 and #250", () => {
  it("keeps the revoke, the guard, the same-owner triggers and policies; approvals still work",
    async () => {
    const owner = (await ensureUser("a")).id;
    const state = appliedState();
    // Step back to the state before these migrations and later sync patches.
    const stepBack = [
      // A later layout patch extends the same sync branch. Remove it before replaying the older
      // anchored migrations; the outer transaction restores the installed schema on rollback.
      state.companions ? down(COMPANIONS_VALIDATE) : "",
      state.companions ? down(COMPANIONS) : "",
      state.mascot ? down(MASCOT_VALIDATE) : "",
      state.mascot ? down(MASCOT) : "",
      state.profileSync ? down(PROFILE_SYNC) : "",
      state.mealLayout ? down(MEAL_LAYOUT) : "",
      state.sameOwner ? down(SAME_OWNER) : "",
      state.guard ? down(GUARD) : "",
      state.rateGoals ? down(RATE_GOALS) : "",
      state.bodyFat ? down(BODY_FAT) : "",
    ];
    const a = "00000000-0000-4000-8000-0000000241a1";
    const b = "00000000-0000-4000-8000-0000000241b2";
    const tag = (label: string, sql: string) => `select '${label}:' || (${sql});`;
    const refused = (label: string, call: string) => [
      "do $t$ begin",
      `  perform ${call};`,
      `  insert into prod_order_result values ('${label}', false);`,
      `exception when insufficient_privilege then insert into prod_order_result values ('${label}', true);`,
      "end $t$;",
    ].join("\n");
    const out = runSql([
      "begin;",
      // The downs refuse to drop data written since their forward run unless told to; this
      // transaction rolls back, so nothing is lost.
      "set local app.allow_down_data_loss = 'on';",
      ...stepBack,
      // Production before PR #249: Supabase's default privileges gave authenticated EXECUTE.
      ...INTERNALS.map((sig) => `grant execute on function public.${sig} to authenticated;`),
      tag("before_auth_exec", "select bool_and(has_function_privilege('authenticated', p.oid, "
        + "'execute')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
        + "where n.nspname = 'public' and p.proname in ('_sync_current', '_sync_upsert', "
        + "'_sync_tombstone')"),
      // Production order.
      up(GUARD),
      up(SAME_OWNER),
      up(BODY_FAT),
      up(RATE_GOALS),
      // A later re-run of the guard migration (or version order on a fresh database) must find
      // the marker and leave one guard per function.
      up(GUARD),
      tag("auth_exec", "select string_agg(p.proname || '=' || has_function_privilege("
        + "'authenticated', p.oid, 'execute'), ',' order by p.proname) from pg_proc p "
        + "join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' "
        + "and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone')"),
      tag("anon_exec", "select bool_or(has_function_privilege('anon', p.oid, 'execute')) "
        + "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = "
        + "'public' and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone')"),
      tag("guard", "select string_agg(p.proname || '=' || (select count(*) from regexp_matches("
        + "p.prosrc, 'p9_sync_caller_guard', 'g')), ',' order by p.proname) from pg_proc p "
        + "join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' "
        + "and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone')"),
      // The PR's patches landed on top of the guarded body.
      tag("upsert_patched", "select position('goal_rate_bp_week' in p.prosrc) > 0 "
        + "and position('body_fat_measured_on' in p.prosrc) > 0 from pg_proc p "
        + "where p.oid = 'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure"),
      tag("target_writers_guarded", "select bool_and(position('_sync_assert_caller(p_user_id)' "
        + "in p.prosrc) > 0) from pg_proc p where p.oid in ("
        + "'public.write_target_revision(uuid,jsonb)'::regprocedure, "
        + "'public.approve_target_proposal(uuid,uuid)'::regprocedure)"),
      tag("same_owner", "select count(*) from pg_trigger where tgname = 'same_owner' "
        + "and tgenabled = 'O' and not tgisinternal"),
      tag("owner_fixed", "select count(*) from pg_trigger where tgname = 'owner_fixed' "
        + "and tgenabled = 'O' and not tgisinternal"),
      tag("same_owner_tables", "select string_agg(c.relname, ',' order by c.relname) "
        + "from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'same_owner'"),
      // PR #250's policies: coach_messages checks the caller's user_id, plan_days has no delete.
      tag("coach_policy", "select position('auth.uid()' in qual) > 0 and position('user_id' in qual) "
        + "< position('EXISTS' in qual) from pg_policies where schemaname = 'public' "
        + "and tablename = 'coach_messages' and policyname = 'coach_messages_rw'"),
      tag("plan_days_delete", "select has_table_privilege('authenticated', 'public.plan_days', "
        + "'delete')"),
      // Review r1 BLOCK: approving a proposal built on a trend weight writes 'trend', which the
      // widened check must accept (as the owner, no JWT: the service-role path).
      "create temp table prod_order_ids on commit drop as select gen_random_uuid() as estimate, "
        + "gen_random_uuid() as proposal;",
      `insert into expenditure_estimates (id, user_id, local_date, status, tdee_kcal, confidence, `
        + `engine_version, weight_trend_kg) select estimate, '${owner}', '2041-03-04', `
        + `'estimating', 2250, 1, 'exp-1.0.0', 80.4 from prod_order_ids;`,
      `insert into target_proposals (id, user_id, week_start, status, proposed, `
        + `based_on_estimate_id) select proposal, '${owner}', '2041-03-04', 'pending', `
        + `'{"kcalTrain":2250,"kcalRest":1800,"proteinG":135,"fatG":85,"carbG":210}'::jsonb, `
        + `estimate from prod_order_ids;`,
      tag("approval", `select r->>'status' || '/' || coalesce(r->'profile'->>'input_weight_source', `
        + `'none') from (select approve_target_proposal('${owner}', proposal) as r `
        + `from prod_order_ids) x`),
      "create temp table prod_order_result (label text, refused boolean) on commit drop;",
      "grant insert on prod_order_result to authenticated;",
      // The guard alone: the owner role (no grant layer) with A's claims, asking for B's rows.
      `select set_config('request.jwt.claims', '{"sub":"${a}","role":"authenticated"}', true);`,
      refused("guard_upsert", `_sync_upsert('${b}', 'water_log', '2041-02-02', '{"cups":1}'::jsonb, 1)`),
      refused("guard_upsert_settings", `_sync_upsert('${b}', 'user_settings', '${b}', `
        + `'{"goal_rate_bp_week":-50,"body_fat_source":"dexa"}'::jsonb, 1)`),
      refused("guard_current", `_sync_current('${b}', 'water_log', '2041-02-02')`),
      refused("guard_tombstone", `_sync_tombstone('${b}', 'user_foods', '${b}', 'delete', 2)`),
      // The grant layer: as authenticated, even A's own id is refused.
      "set local role authenticated;",
      refused("auth_upsert_self", `_sync_upsert('${a}', 'water_log', '2041-02-02', '{"cups":1}'::jsonb, 1)`),
      refused("auth_current_self", `_sync_current('${a}', 'water_log', '2041-02-02')`),
      refused("auth_tombstone_self", `_sync_tombstone('${a}', 'user_foods', '${a}', 'delete', 2)`),
      "reset role;",
      "select 'refused:' || string_agg(label || '=' || refused, ',' order by label) from prod_order_result;",
      "rollback;",
    ].join("\n"));
    const lines = out.split("\n");
    expect(lines).toContain("before_auth_exec:true");
    expect(lines).toContain("auth_exec:_sync_current=false,_sync_tombstone=false,_sync_upsert=false");
    expect(lines).toContain("anon_exec:false");
    expect(lines).toContain("guard:_sync_current=1,_sync_tombstone=1,_sync_upsert=1");
    expect(lines).toContain("upsert_patched:true");
    expect(lines).toContain("target_writers_guarded:true");
    expect(lines).toContain("same_owner:13");
    expect(lines).toContain("coach_policy:true");
    expect(lines).toContain("plan_days_delete:false");
    expect(lines).toContain("approval:approved/trend");
    expect(lines).toContain("owner_fixed:12");
    expect(lines).toContain("same_owner_tables:coach_messages,duplicate_group_members,"
      + "duplicate_groups,favorites_foods,favorites_meal_items,favorites_recipes,health_samples,"
      + "ingest_events,log_items,media_objects,recipe_items,target_proposals,user_food_prefs");
    expect(lines).toContain("refused:auth_current_self=true,auth_tombstone_self=true,"
      + "auth_upsert_self=true,guard_current=true,guard_tombstone=true,guard_upsert=true,"
      + "guard_upsert_settings=true");
  });
  it("on their own, the PR's migrations write the guard and revoke authenticated", () => {
    // Belt and braces: even on a database where PR #249 is absent (its body guard removed and the
    // authenticated grant back), the two PR migrations leave _sync_upsert guarded and revoked.
    const state = appliedState();
    const out = runSql([
      "begin;",
      "set local app.allow_down_data_loss = 'on';",
      state.companions ? down(COMPANIONS_VALIDATE) : "",
      state.companions ? down(COMPANIONS) : "",
      state.mascot ? down(MASCOT_VALIDATE) : "",
      state.mascot ? down(MASCOT) : "",
      state.profileSync ? down(PROFILE_SYNC) : "",
      state.mealLayout ? down(MEAL_LAYOUT) : "",
      state.sameOwner ? down(SAME_OWNER) : "",
      state.guard ? down(GUARD) : "",
      state.rateGoals ? down(RATE_GOALS) : "",
      state.bodyFat ? down(BODY_FAT) : "",
      "grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to authenticated;",
      up(BODY_FAT),
      up(RATE_GOALS),
      "select 'guard:' || (select count(*) from regexp_matches(pg_get_functiondef("
        + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure), "
        + "'p9_sync_caller_guard', 'g'));",
      "select 'auth_exec:' || has_function_privilege('authenticated', "
        + "'public._sync_upsert(uuid,text,text,jsonb,integer)', 'execute');",
      "rollback;",
    ].join("\n"));
    const lines = out.split("\n");
    expect(lines).toContain("guard:1");
    expect(lines).toContain("auth_exec:false");
  });
});
