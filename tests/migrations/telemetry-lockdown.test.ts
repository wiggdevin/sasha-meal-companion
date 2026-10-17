/**
 * W070 (docs/plans/2026-10-10-priority-spec-list.md): the four telemetry lockdown files, read as
 * text so every unit shard checks them. The database half (42501 for A on every writer and on a
 * direct insert into each table) is tests/tenancy/rpc-matrix.test.ts and
 * tests/tenancy/admin-telemetry.test.ts, on the migrated local stack.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), "supabase/migrations", p), "utf8");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const WRITERS = read("20270105140000_telemetry_service_writers.sql");
const NOT_VALID = read("20270105140100_client_timings_checks_not_valid.sql");
const VALIDATE = read("20270105140200_client_timings_checks_validate.sql");
const LOCKDOWN = read("20270105140300_telemetry_insert_lockdown.sql");
const DOWNS = ["20270105140000_telemetry_service_writers", "20270105140100_client_timings_checks_not_valid",
  "20270105140200_client_timings_checks_validate", "20270105140300_telemetry_insert_lockdown"]
  .map((name) => read(`down/${name}.down.sql`));

describe("W070 telemetry lockdown migrations", () => {
  it("every file, up and down, runs under a 3 s lock timeout", () => {
    for (const sql of [WRITERS, NOT_VALID, VALIDATE, LOCKDOWN, ...DOWNS]) {
      expect(sql).toContain("set local lock_timeout = '3s';");
    }
  });

  it("the two _for writers are security definer and service_role only", () => {
    const sql = code(WRITERS);
    for (const fn of ["record_food_signals_for", "record_onboarding_events_for"]) {
      expect(sql).toMatch(new RegExp(`function public\\.${fn}\\(p_user_id uuid, p_events jsonb\\)[\\s\\S]*?security definer set search_path = ''`));
      expect(sql).toContain(`revoke all on function public.${fn}(uuid, jsonb) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${fn}(uuid, jsonb) to service_role;`);
    }
    expect(sql).not.toMatch(/auth\.uid\(\)/);
  });

  it("re-adds both client_timings checks NOT VALID, then validates them in the next file", () => {
    const sql = code(NOT_VALID);
    for (const name of ["client_timings_path_check", "client_timings_step_check"]) {
      expect(sql).toMatch(new RegExp(`drop constraint if exists ${name},\\s*add constraint ${name}\\s*check \\([^;]*?\\) not valid`));
      expect(code(VALIDATE)).toContain(`alter table public.client_timings validate constraint ${name};`);
    }
  });

  it("revokes every direct insert and the invoker RPCs from authenticated, and proves none is left", () => {
    const sql = code(LOCKDOWN);
    for (const table of ["client_timings", "food_signal_events", "onboarding_events"]) {
      expect(sql).toContain(`revoke insert on table public.${table} from authenticated;`);
      expect(sql).toContain(`drop policy if exists ${table}_insert on public.${table};`);
    }
    for (const fn of ["record_food_signals", "record_onboarding_events"]) {
      expect(sql).toContain(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated;`);
    }
    expect(sql).toContain("has_any_column_privilege('authenticated'");
    expect(sql).not.toMatch(/grant [^;]* to authenticated/);
  });

  it("says when each file is applied: writers before the deploy, the lockdown after it", () => {
    expect(WRITERS).toContain("apply to production BEFORE the W070 code");
    expect(LOCKDOWN).toContain("apply to production AFTER the W070 code deploys, never before");
  });
});
