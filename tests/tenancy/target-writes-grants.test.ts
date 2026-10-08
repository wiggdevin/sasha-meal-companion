/**
 * Migration 20261228090000: the four target writers are service-role only. Before it,
 * `authenticated` could execute write_target_revision, write_target_revision_if_active,
 * write_target_revision_pair and approve_target_proposal over PostgREST for its own account
 * (their `_sync_assert_caller` guard only binds p_user_id to auth.uid()) and so skip the adult
 * floor, the pace holds, the pace caps and the floors that lib/server/targets.ts applies.
 *
 * Static checks read the SQL; the database block applies the migration inside a transaction and
 * rolls it back, so it proves the revoke and the service-role path on any local stack without
 * leaving a change behind. tests/tenancy/rpc-matrix.test.ts covers the same refusal over
 * PostgREST once the migration is applied.
 */
// Refuses any non-local database before anything else runs.
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const MIGRATION = "20261228090000_target_writes_service_role_only";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (text: string) =>
  text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const SIGNATURES = [
  "write_target_revision(uuid, jsonb)",
  "write_target_revision_if_active(uuid, jsonb, uuid, bigint)",
  "write_target_revision_pair(uuid, jsonb, jsonb)",
  "approve_target_proposal(uuid, uuid)",
];
const UP_RAW = read(`supabase/migrations/${MIGRATION}.sql`);
const DOWN_RAW = read(`supabase/migrations/down/${MIGRATION}.down.sql`);

describe(`${MIGRATION} (static)`, () => {
  const UP = sqlOnly(UP_RAW).replace(/\s+/g, " ");
  const DOWN = sqlOnly(DOWN_RAW).replace(/\s+/g, " ");

  it("revokes EXECUTE from public, anon and authenticated on all four writers", () => {
    for (const sig of SIGNATURES) {
      expect(UP).toContain(`revoke execute on function public.${sig} from public, anon, authenticated;`);
    }
  });

  it("keeps the service role able to run them, under a lock timeout", () => {
    expect(UP).toContain("set local lock_timeout = '3s';");
    for (const sig of SIGNATURES) expect(UP).toContain(`grant execute on function public.${sig} to service_role;`);
  });

  it("changes no function body and grants nothing to authenticated", () => {
    expect(UP).not.toMatch(/create (or replace )?function|alter function|drop function/i);
    expect(UP).not.toMatch(/grant [^;]*\bto\b[^;]*\b(authenticated|anon|public)\b/i);
  });

  it("down never re-grants authenticated", () => {
    expect(DOWN).not.toMatch(/grant [^;]*\bto\b [^;]*\b(authenticated|anon|public)\b/i);
  });
});

describe.skipIf(!HAS_DB)(`${MIGRATION} (database, rolled back)`, () => {
  const EXEC = (role: string) => "select '" + role + ":' || string_agg(p.proname || '=' || "
    + `has_function_privilege('${role}', p.oid, 'execute'), ',' order by p.proname) `
    + "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' "
    + "and p.proname in ('write_target_revision', 'write_target_revision_if_active', "
    + "'write_target_revision_pair', 'approve_target_proposal');";
  const NONE = (role: string) => `${role}:approve_target_proposal=false,write_target_revision=false,`
    + "write_target_revision_if_active=false,write_target_revision_pair=false";

  it("authenticated, anon and public lose EXECUTE; service_role keeps it; a second run changes nothing", () => {
    const sub = "00000000-0000-4000-8000-0000000000a1";
    const refused = (call: string, tag: string) => [
      "do $t$ begin",
      `  perform ${call};`,
      `  raise exception 'reachable_${tag}';`,
      "exception when insufficient_privilege then null;",
      "end $t$;",
    ].join("\n");
    const out = runSql([
      "begin;",
      UP_RAW,
      UP_RAW,
      EXEC("authenticated"),
      EXEC("anon"),
      EXEC("public"),
      EXEC("service_role"),
      "set local role authenticated;",
      `select set_config('request.jwt.claims', '{"sub":"${sub}","role":"authenticated"}', true);`,
      // The account's own id: refused before the body runs (permission denied, 42501).
      refused(`write_target_revision('${sub}', '{}'::jsonb)`, "write"),
      refused(`write_target_revision_if_active('${sub}', '{}'::jsonb, null, null)`, "if_active"),
      refused(`write_target_revision_pair('${sub}', '{}'::jsonb, '{}'::jsonb)`, "pair"),
      refused(`approve_target_proposal('${sub}', gen_random_uuid())`, "approve"),
      "reset role;",
      "select 'scenario_done:true';",
      "rollback;",
    ].join("\n"));
    const lines = out.split("\n");
    expect(lines).toContain(NONE("authenticated"));
    expect(lines).toContain(NONE("anon"));
    expect(lines).toContain(NONE("public"));
    expect(lines).toContain("service_role:approve_target_proposal=true,write_target_revision=true,"
      + "write_target_revision_if_active=true,write_target_revision_pair=true");
    expect(lines).toContain("scenario_done:true");
  });

  it("the SQL callers still reach write_target_revision as the owner (security definer)", () => {
    const out = runSql([
      "begin;",
      UP_RAW,
      "select 'definer:' || bool_and(p.prosecdef) from pg_proc p where p.oid in ("
        + "'public.write_target_revision_if_active(uuid,jsonb,uuid,bigint)'::regprocedure, "
        + "'public.write_target_revision_pair(uuid,jsonb,jsonb)'::regprocedure, "
        + "'public.approve_target_proposal(uuid,uuid)'::regprocedure);",
      "rollback;",
    ].join("\n"));
    expect(out.split("\n")).toContain("definer:true");
  });
});
