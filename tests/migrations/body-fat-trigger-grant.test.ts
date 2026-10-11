// 20261116090000: the body-fat provenance trigger function is internal. 20261028090000 created it,
// and Supabase's default privileges gave `authenticated` EXECUTE, which the RPC manifest
// (tests/tenancy/rpc-matrix.test.ts) flags as an undeclared function. Same rule as the PR #250
// trigger functions: revoke from every client role.
// Refuses any non-local database before anything else runs.
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql } from "../helpers/supabase";

const NAME = "20261116090000_body_fat_trigger_revoke";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read(`supabase/migrations/${NAME}.sql`);
const DOWN = read(`supabase/migrations/down/${NAME}.down.sql`);
const sqlOnly = (text: string) =>
  text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe(`${NAME}.sql`, () => {
  it("revokes the trigger function from public, anon and authenticated", () => {
    expect(UP).toContain("revoke all on function public.user_settings_body_fat_provenance() "
      + "from public, anon, authenticated;");
  });

  it("down never grants it back to a client role", () => {
    expect(sqlOnly(DOWN)).not.toMatch(/grant[^;]*(authenticated|anon|public)/i);
  });
});

describe.skipIf(!(HAS_DB && HAS_BRANCH))("the body-fat provenance trigger after the revoke", () => {
  it("is not executable by authenticated or anon, and still fires on a write", async () => {
    const owner = (await ensureUser("a")).id;
    // A database that predates 20261028090000 gets it first, inside the same rolled-back
    // transaction.
    const out = runSql("select 'has_fn:' || (to_regprocedure("
      + "'public.user_settings_body_fat_provenance()') is not null);").includes("has_fn:true")
      ? runSql(["begin;", UP, check(owner), "rollback;"].join("\n"))
      : runSql(["begin;", read("supabase/migrations/20261028090000_body_fat_provenance.sql"), UP,
        check(owner), "rollback;"].join("\n"));
    const lines = out.split("\n");
    expect(lines).toContain("auth_exec:false");
    expect(lines).toContain("anon_exec:false");
    expect(lines).toContain("fired:true");
  });
});

function check(owner: string): string {
  const fn = "'public.user_settings_body_fat_provenance()'";
  return [
    `select 'auth_exec:' || has_function_privilege('authenticated', ${fn}, 'execute');`,
    `select 'anon_exec:' || has_function_privilege('anon', ${fn}, 'execute');`,
    // A signed-in user's own write still runs the trigger: setting body fat without a source
    // on a row that had one clears the stale provenance.
    // Test user A's own settings row (created here if the account has none; rolled back).
    `insert into user_settings (user_id, first_opened_at) values ('${owner}', now()) `
      + "on conflict (user_id) do nothing;",
    `create temp table fired_probe on commit drop as select '${owner}'::uuid as user_id;`,
    "update user_settings s set body_fat_pct = 20, body_fat_source = 'dexa', "
      + "body_fat_measured_on = current_date from fired_probe p where s.user_id = p.user_id;",
    "select set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', "
      + "'authenticated')::text, true) from fired_probe;",
    // W018 (20261231170000) made user_settings select-only for a session; this rolled-back
    // transaction puts an owner UPDATE back so the session write can reach the trigger.
    "grant update on user_settings to authenticated;",
    "create policy user_settings_test_update on user_settings for update to authenticated "
      + "using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));",
    "set local role authenticated;",
    "update user_settings set body_fat_pct = 21 where user_id = (select auth.uid());",
    "reset role;",
    "select 'fired:' || (select s.body_fat_source is null from user_settings s "
      + "join fired_probe p on p.user_id = s.user_id);",
  ].join("\n");
}
