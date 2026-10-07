/**
 * T11b: the four body-profile columns, the sync contract they copy from T6, and the two columns
 * the SQL `daily_health` view gains.
 *
 * Same two halves as tests/water/migration.test.ts. The text assertions cover statement order and
 * the case-when form that a live branch cannot show. The psql half runs the real migration inside a
 * transaction that ends in ROLLBACK: apply UP, write a profile through `_sync_upsert`, show that an
 * update which omits the keys keeps them, show that an explicit JSON null clears a nullable one, and
 * read the view's new columns. The down half then applies UP **and** DOWN in one transaction and
 * compares the function and the view before and after. Both start from the fully migrated branch, apply DOWN inside the transaction to establish
 * the old schema, then roll back to preserve the actual latest schema and functions.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureUser, HAS_BRANCH, HAS_DB, runSql } from "../helpers/supabase";

const NAME = "20261013090000_body_profile";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");
/** T6's own file, whose `_sync_upsert` the down must restore byte for byte. */
const T6 = readFileSync("supabase/migrations/20261012090000_water_goal_by_day_type.sql", "utf8");
const T6_FUNCTION = T6.slice(T6.indexOf("create or replace function _sync_upsert"),
  T6.indexOf("revoke execute on function _sync_upsert"));

const COLUMNS = ["height_cm", "birth_year", "sex", "body_fat_pct"];
/**
 * Step C's `user_settings_body_fat_provenance` trigger fires on `update of body_fat_pct`, so that
 * column cannot be dropped while the trigger exists. A real rollback unwinds the newer migration
 * first; each scene below does the same minimal thing before T11b's own down, and the closing
 * ROLLBACK puts the trigger back with everything else.
 */
const DROP_DEPENDENT_TRIGGER =
  "drop trigger if exists user_settings_body_fat_provenance on user_settings;";

describe(`${NAME}.sql`, () => {
  it("adds four nullable columns with their types and checks", () => {
    expect(UP).toContain("add column height_cm numeric");
    expect(UP).toContain("add column birth_year integer");
    expect(UP).toContain(
      "birth_year between 1900 and extract(year from current_date)::integer",
    );
    expect(UP).not.toContain("birth_year between 1900 and 2100");
    expect(UP).toContain("add column sex text");
    expect(UP).toContain("check (sex in ('female','male'))");
    expect(UP).toContain("add column body_fat_pct numeric");
    for (const column of COLUMNS) expect(UP).not.toContain(`${column} not null`);
  });

  it("replaces _sync_upsert once, carrying all four on the whole-row write", () => {
    expect(UP.match(/create or replace function _sync_upsert/g) ?? []).toHaveLength(1);
    expect(UP).toContain("water_goal_cups_training, water_goal_cups_rest, height_cm, birth_year,");
    expect(UP).toContain("sex, body_fat_pct, rev)");
    expect(UP).toContain("revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer)");
  });

  // T6's contract, copied: omitted key = keep the stored value, present JSON null = clear a
  // nullable column. Without key presence, an old phone's settings row would wipe her height, age,
  // sex and body-fat % every time she touched a calorie stepper.
  it("keeps an omitted key on update and lets an explicit null clear it", () => {
    for (const column of COLUMNS) {
      expect(UP).toContain(`${column} = case when p_payload ? '${column}'`);
      expect(UP).toContain(`else user_settings.${column} end`);
      expect(UP).not.toContain(`${column} = excluded.${column}`);
    }
    expect(UP).toContain("(p_payload->>'height_cm')::numeric");
    expect(UP).toContain("(p_payload->>'birth_year')::integer");
    expect(UP).toContain("p_payload->>'sex'");
    expect(UP).toContain("(p_payload->>'body_fat_pct')::numeric");
    // The water goals keep T6's own rules: refuse an explicit null, never reset an omitted one.
    expect(UP).toContain("raise exception 'water_goal_null:");
    expect(UP).toContain("water_goal_cups_training = case when p_payload ? 'water_goal_cups_training'");
  });

  it("appends the heart and readiness columns to the daily_health view without disturbing it", () => {
    expect(UP).toContain("create or replace view daily_health with (security_invoker = true)");
    // Eighth round, finding 4: the view is the SQL half of the same number lib/health/daily.ts rolls
    // up, so it keeps the value at full numeric precision and ROUNDS NOTHING — the renderer rounds.
    expect(UP).toContain(
      "(min(value) filter (where type = 'resting_heart_rate'))::numeric as resting_heart_rate");
    expect(UP).toContain("(avg(value) filter (where type = 'hrv_sdnn'))::numeric");
    expect(UP).toContain("as hrv_sdnn");
    // T11b finding 3: readiness, the day's latest sample — the same rule lib/health/daily.ts applies.
    expect(UP).toContain("(array_agg(value order by end_time desc) filter (where type = 'readiness_score'))[1])::numeric");
    expect(UP).toContain("as readiness_score");
    const view = UP.slice(UP.indexOf("create or replace view daily_health"));
    expect(view).not.toMatch(/round\s*\(/);
    expect(UP).toContain("grant select on daily_health to authenticated");
    // CREATE OR REPLACE VIEW can only append: the contract columns stay in their order.
    const order = ["as steps", "as active_kcal", "as sleep_minutes", "as body_mass_kg",
      "as resting_heart_rate", "as hrv_sdnn", "as readiness_score"];
    for (let i = 1; i < order.length; i += 1) {
      expect(view.indexOf(order[i - 1])).toBeLessThan(view.indexOf(order[i]));
    }
  });

  it("down restores T6's _sync_upsert before dropping the four columns", () => {
    expect(DOWN).toContain("create or replace function _sync_upsert");
    expect(DOWN).toContain("water_goal_cups_training = case when p_payload ? 'water_goal_cups_training'");
    expect(DOWN).not.toContain("height_cm = case when");
    // T6's own rule comes back with T6's function.
    expect(DOWN).toContain("raise exception 'water_goal_null:");
    for (const column of COLUMNS) expect(DOWN).toContain(`drop column ${column}`);
    expect(DOWN).not.toContain("drop column water_goal_cups ");
    expect(DOWN.indexOf("create or replace function _sync_upsert"))
      .toBeLessThan(DOWN.indexOf("drop column height_cm"));
  });
});

const canRunSql = HAS_BRANCH && HAS_DB;

describe.skipIf(!canRunSql)("the profile columns on a live branch", () => {
  it("inserts, keeps and clears the four columns, and widens the view", async () => {
    const user = await ensureUser("b");
    const base = { first_opened_at: "2026-09-01T00:00:00.000Z" };
    const created = { ...base, water_goal_cups: 10, height_cm: 165, birth_year: 1996,
      sex: "female", body_fat_pct: 25 };
    const omitted = { ...base, training_kcal: 2400 };
    const cleared = { ...base, height_cm: null, body_fat_pct: null, sex: "male" };
    const sql = (...lines: string[]) => lines.join(" ");
    // Null sentinels, never concat_ws: concat_ws SKIPS nulls, so a cleared row read as
    // "1996/male" and a test could not tell ∅ from a value (Sol audit finding 12).
    const cell = (column: string) => `coalesce(${column}::text,'∅')`;
    const row = (marker: string) => sql(`select '${marker}:' || ${cell("height_cm")} || '/' ||`,
      `${cell("birth_year")} || '/' || ${cell("sex")} || '/' || ${cell("body_fat_pct")}`,
      `from user_settings where user_id = '${user.id}';`);
    const upsert = (payload: object, rev: number) => sql("select _sync_upsert(",
      `'${user.id}', 'user_settings', 'settings', '${JSON.stringify(payload)}'::jsonb, ${rev});`);
    const colCount = (marker: string, table: string) => sql(
      `select '${marker}:' || count(*) from information_schema.columns`,
      `where table_name = '${table}'`,
      `and column_name in (${COLUMNS.map((c) => `'${c}'`).join(", ")});`);
    const scene = [
      "begin;",
      DROP_DEPENDENT_TRIGGER,
      DOWN, // Establish the pre-migration schema; ROLLBACK restores the actual latest state.
      colCount("t11b_pre_cols", "user_settings"),
      UP,
      colCount("t11b_cols", "user_settings"),
      sql("select 't11b_view_cols:' || count(*) from information_schema.columns",
        "where table_name = 'daily_health'",
        "and column_name in ('resting_heart_rate', 'hrv_sdnn', 'readiness_score');"),
      sql("select 't11b_sex_constraint:' || count(*) from pg_constraint c",
        "join pg_class t on t.oid = c.conrelid where t.relname = 'user_settings'",
        "and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%sex%';"),
      `delete from user_settings where user_id = '${user.id}';`,
      upsert(created, 1),
      row("t11b_inserted"),
      upsert(omitted, 2),
      row("t11b_kept"),
      upsert(cleared, 3),
      row("t11b_cleared"),
      "create temporary table t12b_assertions (marker text);",
      sql("do $$ begin", "perform _sync_upsert(",
        `'${user.id}', 'user_settings', 'settings',`,
        "jsonb_build_object('first_opened_at', '2026-09-01T00:00:00.000Z',",
        "'birth_year', extract(year from current_date)::integer + 1), 4);",
        "insert into t12b_assertions values ('accepted_future_birth_year');",
        "exception when check_violation then",
        "insert into t12b_assertions values ('rejected_future_birth_year'); end $$;"),
      "select marker from t12b_assertions;",
      "rollback;",
    ].join("\n");

    const out = runSql(scene);
    expect(out).toContain("t11b_pre_cols:0");
    expect(out).toContain("t11b_cols:4");
    expect(out).toContain("t11b_view_cols:3");
    expect(out).not.toContain("t11b_sex_constraint:0");
    expect(out).toContain("t11b_inserted:165/1996/female/25");
    expect(out).toContain("t11b_kept:165/1996/female/25");
    // An explicit null clears height and body-fat; birth_year and sex keep the stored values.
    expect(out).toContain("t11b_cleared:∅/1996/male/∅");
    expect(out).not.toContain("t11b_cleared:165");
    expect(out).toContain("rejected_future_birth_year");
    expect(out).not.toContain("accepted_future_birth_year");
  });
});

/**
 * Sol audit finding 1: the down's view statement used `create or replace view`, which Postgres
 * refuses when it drops a column ("cannot drop columns from view"), so the whole rollback aborted.
 * The fix drops and rebuilds the view. This runs UP then DOWN inside one transaction and rolls
 * back, then compares T6's `_sync_upsert` before the UP with the one the DOWN restores, and checks
 * the view's five columns, its `security_invoker` reloption and its `authenticated` grant.
 */
describe.skipIf(!canRunSql)("the down migration", () => {
  it("restores the five-column view, its invoker flag and grant, and T6's _sync_upsert", () => {
    const fnHash = (marker: string) =>
      `select '${marker}:' || md5(pg_get_functiondef('_sync_upsert'::regproc));`;
    const scene = [
      "begin;",
      DROP_DEPENDENT_TRIGGER,
      DOWN, // Rollback below preserves the latest schema and function definitions.
      // Normalise to T6's own text first: a preview branch pushed before T6's last revision would
      // otherwise be the only difference between the two hashes, and that is not this ticket.
      T6_FUNCTION,
      fnHash("t11b_fn_before"),
      UP,
      "select 't11b_view_up:' || count(*) from information_schema.columns",
      "where table_name = 'daily_health'",
      "and column_name in ('resting_heart_rate', 'hrv_sdnn', 'readiness_score');",
      DOWN,
      fnHash("t11b_fn_after"),
      "select 't11b_view_down:' || count(*) from information_schema.columns",
      "where table_name = 'daily_health';",
      "select 't11b_view_hearts:' || count(*) from information_schema.columns",
      "where table_name = 'daily_health'",
      "and column_name in ('resting_heart_rate', 'hrv_sdnn');",
      "select 't11b_view_readiness:' || count(*) from information_schema.columns",
      "where table_name = 'daily_health' and column_name = 'readiness_score';",
      "select 't11b_view_order:' || string_agg(column_name, ',' order by ordinal_position)",
      "from information_schema.columns where table_name = 'daily_health';",
      "select 't11b_view_invoker:' || coalesce((select array_to_string(reloptions, ',')",
      "from pg_class where relname = 'daily_health'), 'none');",
      "select 't11b_view_grant:' || count(*) from information_schema.role_table_grants",
      "where table_name = 'daily_health' and grantee = 'authenticated'",
      "and privilege_type = 'SELECT';",
      "rollback;",
    ].join("\n");

    const out = runSql(scene);
    expect(out).toContain("t11b_view_up:3");
    // The original view is user_id + local_date + four metrics — six columns, the two heart ones
    // and readiness gone (the audit's "five-column" was shorthand for the four contract metrics).
    expect(out).toContain("t11b_view_down:6");
    expect(out).toContain("t11b_view_hearts:0");
    expect(out).toContain("t11b_view_readiness:0");
    expect(out).toContain("t11b_view_order:user_id,local_date,steps,active_kcal,sleep_minutes,"
      + "body_mass_kg");
    expect(out).toContain("t11b_view_invoker:security_invoker=true");
    expect(out).toContain("t11b_view_grant:1");
    const before = out.match(/t11b_fn_before:([0-9a-f]+)/)?.[1];
    const after = out.match(/t11b_fn_after:([0-9a-f]+)/)?.[1];
    expect(before).toBeTruthy();
    expect(after).toBe(before);
  });
});
