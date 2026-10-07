/**
 * Phase 18 W5 (spec §6 migration 4): the three profile_cuisines_country files. Static checks run in
 * every unit shard; the database half steps the files down and up again inside one transaction on
 * the local stack and rolls it back. Production is applied by the owner, with a backup, one file at
 * a time, before the W5 code merges.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) => t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const NAMES = ["20261217090000_profile_cuisines_country", "20261217090100_profile_cuisines_country_validate",
  "20261217090200_profile_sync_cuisines_country"];
/**
 * Later migrations that depend on these columns (Phase 18 W5b-2: the taste_chip_holds_release trigger
 * reads user_settings.cuisines and diet_prefs). A round trip steps them down first, in reverse order,
 * and back up after.
 */
const LATER = ["20261220090000_taste_chip_receipts", "20261220090100_coach_undo_taste_mode",
  "20261220090200_coach_undo_taste_mode_validate"];
/**
 * UI-NEEDS SPROUT-CARE's mascot migration patches the SAME `_sync_upsert` user_settings branch
 * this stack's own sync patch (NAMES[2]) does, layered on top of it in production. A round trip
 * on a database that already carries it (every real target does) must take it off first and put
 * it back last, or NAMES[2]'s own down anchors see a function with extra text spliced into them
 * mid-match and refuse as only partly patched.
 */
const MASCOT = ["20261225090000_user_settings_mascot", "20261225090010_user_settings_mascot_validate"];
const up = (name: string) => read(`supabase/migrations/${name}.sql`);
const down = (name: string) => read(`supabase/migrations/down/${name}.down.sql`);
const laterDown = () => [...LATER].reverse().map(down);
const laterUp = () => LATER.map(up);
const mascotDown = () => [...MASCOT].reverse().map(down);
const mascotUp = () => MASCOT.map(up);

describe("profile_cuisines_country migrations (static)", () => {
  it("are live-safe: lock and statement timeouts, a constant default, checks added NOT VALID then validated", () => {
    for (const name of NAMES) {
      expect(up(name)).toContain("set local lock_timeout = '3s';");
      expect(up(name)).toContain("set local statement_timeout = '30s';");
    }
    const columns = sqlOnly(up(NAMES[0]));
    expect(columns).toContain("add column cuisines text[] default '{}';");
    expect(columns).toContain("add column country_code text;");
    expect(columns.match(/\) not valid;/g)).toHaveLength(3);
    expect(columns).not.toMatch(/\bvalidate constraint\b|set not null|\bupdate public\.user_settings\b/);
    const validate = sqlOnly(up(NAMES[1]));
    for (const check of ["user_settings_cuisines_valid", "user_settings_country_code_check",
      "user_settings_diet_prefs_taste_check"]) expect(validate).toContain(`validate constraint ${check};`);
    expect(validate).toContain("alter column cuisines set not null;");
  });

  it("adds no state, region, race or ethnicity column", () => {
    for (const name of NAMES) expect(sqlOnly(up(name))).not.toMatch(/add column [a-z_]*(state|region|race|ethnic)/i);
  });

  it("keeps the _sync_upsert grant at service_role only", () => {
    const sync = sqlOnly(up(NAMES[2]));
    expect(sync).toContain("revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)\n  from public, anon, authenticated;");
    expect(sync).not.toMatch(/grant execute[^;]*_sync_upsert[^;]*(authenticated|anon)/);
  });

  it("has a down file for each, and the column down refuses to drop chosen answers", () => {
    for (const name of NAMES) expect(down(name).length).toBeGreaterThan(0);
    expect(down(NAMES[0])).toContain("app.allow_down_data_loss");
  });
});

describe.skipIf(!HAS_DB)("profile_cuisines_country migrations (database, rolled back)", () => {
  const owner = "00000000-0000-4000-8000-0000000005a5";
  const seed = [
    "begin;",
    `insert into auth.users (id, email) values ('${owner}', 'w5-migration@meal-companion.test');`,
    `insert into public.user_settings (user_id, first_opened_at, cuisines, country_code) values ('${owner}', now(), '{korean}', 'US');`,
  ];

  it("the column down refuses while an account has chosen a cuisine or a country", () => {
    expect(() => runSql([...seed, ...mascotDown(), ...laterDown(), down(NAMES[2]), down(NAMES[1]),
      down(NAMES[0]), "rollback;"].join("\n")))
      .toThrow(/accounts have chosen cuisines or a country/);
  });

  it("steps down and up again in order; defaults, NOT NULL and the sync patch come back", () => {
    const out = runSql([...seed,
      "set local app.allow_down_data_loss = 'on';",
      // The pre-down function text, captured before mascotDown touches it, so the later
      // round-trip assertion can prove the mascot patch itself comes back byte for byte.
      "select set_config('test.pre_mascot_def', pg_get_functiondef("
        + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)::text, true);",
      ...mascotDown(), ...laterDown(), down(NAMES[2]), down(NAMES[1]), down(NAMES[0]),
      "select 'dropped:' || not exists (select 1 from information_schema.columns where table_name = 'user_settings'"
        + " and column_name in ('cuisines', 'country_code'));",
      "select 'sync_clean:' || (position('cuisines' in pg_get_functiondef("
        + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)) = 0);",
      up(NAMES[0]), up(NAMES[1]), up(NAMES[2]), ...laterUp(),
      "select 'later_back:' || (to_regclass('public.taste_chip_holds') is not null and exists (select 1 from"
        + " pg_trigger where tgname = 'taste_chip_holds_release'));",
      `select 'defaults:' || (select cuisines = '{}' and country_code is null from public.user_settings where user_id = '${owner}');`,
      "select 'not_null:' || (select is_nullable = 'NO' from information_schema.columns"
        + " where table_name = 'user_settings' and column_name = 'cuisines');",
      "select 'sync:' || (position('cuisines_null' in pg_get_functiondef("
        + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)) > 0);",
      ...mascotUp(),
      `select 'mascot_default:' || (select mascot = 'sprout' from public.user_settings where user_id = '${owner}');`,
      "select 'mascot_roundtrip:' || (pg_get_functiondef("
        + "'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)::text"
        + " = current_setting('test.pre_mascot_def'));",
      "rollback;",
    ].join("\n"));
    expect(out.split("\n").filter((line) => /^[a-z_]+:(true|false)$/.test(line)))
      .toEqual(["dropped:true", "sync_clean:true", "later_back:true", "defaults:true", "not_null:true", "sync:true",
        "mascot_default:true", "mascot_roundtrip:true"]);
  });
});
