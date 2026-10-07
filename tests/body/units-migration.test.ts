import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureUser, HAS_BRANCH, HAS_DB, runSql } from "../helpers/supabase";

const NAME = "20261025090100_user_settings_units";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");
const PREVIOUS = readFileSync("supabase/migrations/20261022090000_profile_targets.sql", "utf8");

function syncFunction(sql: string): string {
  const start = sql.indexOf("create or replace function _sync_upsert");
  const end = sql.indexOf("end; $$;", start);
  if (start < 0 || end < 0) throw new Error("migration has no full _sync_upsert definition");
  return sql.slice(start, end + "end; $$;".length);
}

describe(`${NAME}.sql`, () => {
  it("adds nullable constrained display-unit columns", () => {
    expect(UP).toContain("add column height_unit text");
    expect(UP).toContain("add column weight_unit text");
    expect(UP).toContain("height_unit in ('ft_in', 'cm')");
    expect(UP).toContain("weight_unit in ('lb', 'kg')");
  });

  it("replaces the single full sync function without a renamed helper", () => {
    expect(UP.match(/create or replace function _sync_upsert/g) ?? []).toHaveLength(1);
    expect(UP).not.toContain("rename to _sync_upsert_without_unit_preferences");
    expect(UP).not.toContain("_sync_upsert_without_unit_preferences(");
    expect(UP).toContain("elsif p_entity = 'log_entries' then");
    expect(UP).toContain("elsif p_entity = 'favorites_meals' then");
    expect(UP).toContain("return _sync_current(p_user_id, p_entity, p_key);");
  });

  it("preserves omitted unit fields and clears explicit nulls in the whole-row branch", () => {
    expect(UP).toContain("height_unit, weight_unit, rev)");
    expect(UP).toContain("p_payload->>'height_unit', p_payload->>'weight_unit', p_rev)");
    expect(UP).toContain("height_unit = case when p_payload ? 'height_unit'");
    expect(UP).toContain("else user_settings.height_unit end");
    expect(UP).toContain("weight_unit = case when p_payload ? 'weight_unit'");
    expect(UP).toContain("else user_settings.weight_unit end");
  });

  it("keeps the established privilege tail without adding grants", () => {
    expect(UP).toContain(
      "revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;",
    );
    expect(UP).not.toContain("grant execute on function _sync_upsert");
  });

  it("down restores the previous full function verbatim before dropping the columns", () => {
    expect(syncFunction(DOWN)).toBe(syncFunction(PREVIOUS));
    expect(DOWN.indexOf("create or replace function _sync_upsert"))
      .toBeLessThan(DOWN.indexOf("drop column height_unit"));
    expect(DOWN).toContain("drop column weight_unit");
    expect(DOWN).not.toContain("rename to _sync_upsert");
  });
});

const canRunSql = HAS_BRANCH && HAS_DB;

describe.skipIf(!canRunSql)(`${NAME} against the local database`, () => {
  it("round-trips one full function with the expected privileges and omit/null behavior", async () => {
    const user = await ensureUser("b");
    const signature = "public._sync_upsert(uuid,text,text,jsonb,integer)";
    const functionHash = (marker: string) =>
      `select '${marker}:' || md5(pg_get_functiondef('${signature}'::regprocedure));`;
    const sql = [
      "begin;",
      DOWN,
      functionHash("units_before"),
      UP,
      "select 'units_function_count:' || count(*) from pg_proc p",
      "  join pg_namespace n on n.oid = p.pronamespace",
      "  where n.nspname = 'public' and p.proname = '_sync_upsert';",
      "select 'units_helper_count:' || count(*) from pg_proc p",
      "  join pg_namespace n on n.oid = p.pronamespace",
      "  where n.nspname = 'public'",
      "  and p.proname = '_sync_upsert_without_unit_preferences';",
      `select 'units_service:' || has_function_privilege('service_role', '${signature}', 'execute');`,
      `select 'units_authenticated:' || has_function_privilege('authenticated', '${signature}', 'execute');`,
      `select 'units_anon:' || has_function_privilege('anon', '${signature}', 'execute');`,
      `delete from user_settings where user_id = '${user.id}';`,
      `select _sync_upsert('${user.id}', 'user_settings', 'settings',`,
      "  '{\"first_opened_at\":\"2026-09-01T00:00:00.000Z\",\"height_unit\":\"cm\",\"weight_unit\":\"kg\"}'::jsonb, 1);",
      `select 'units_created:' || height_unit || '/' || weight_unit from user_settings`,
      `  where user_id = '${user.id}';`,
      `select _sync_upsert('${user.id}', 'user_settings', 'settings',`,
      "  '{\"training_kcal\":2400}'::jsonb, 2);",
      `select 'units_omitted:' || height_unit || '/' || weight_unit from user_settings`,
      `  where user_id = '${user.id}';`,
      `select _sync_upsert('${user.id}', 'user_settings', 'settings',`,
      "  '{\"height_unit\":null,\"weight_unit\":null}'::jsonb, 3);",
      "select 'units_cleared:' || coalesce(height_unit, 'null') || '/'",
      "  || coalesce(weight_unit, 'null') from user_settings",
      `  where user_id = '${user.id}';`,
      DOWN,
      functionHash("units_after"),
      "select 'units_columns_after_down:' || count(*) from information_schema.columns",
      "  where table_schema = 'public' and table_name = 'user_settings'",
      "  and column_name in ('height_unit', 'weight_unit');",
      "select 'units_helper_after_down:' || count(*) from pg_proc p",
      "  join pg_namespace n on n.oid = p.pronamespace",
      "  where n.nspname = 'public'",
      "  and p.proname = '_sync_upsert_without_unit_preferences';",
      "rollback;",
    ].join("\n");

    const out = runSql(sql);
    expect(out).toContain("units_function_count:1");
    expect(out).toContain("units_helper_count:0");
    expect(out).toContain("units_service:true");
    // 20261103090000 revoked authenticated: signed-in users could call _sync_upsert for another
    // account. The revoke survives this migration's create-or-replace round trip.
    expect(out).toContain("units_authenticated:false");
    expect(out).toContain("units_anon:false");
    expect(out).toContain("units_created:cm/kg");
    expect(out).toContain("units_omitted:cm/kg");
    expect(out).toContain("units_cleared:null/null");
    expect(out).toContain("units_columns_after_down:0");
    expect(out).toContain("units_helper_after_down:0");
    expect(out.match(/units_before:([0-9a-f]+)/)?.[1]).toBeTruthy();
    expect(out.match(/units_after:([0-9a-f]+)/)?.[1])
      .toBe(out.match(/units_before:([0-9a-f]+)/)?.[1]);
  });
});
