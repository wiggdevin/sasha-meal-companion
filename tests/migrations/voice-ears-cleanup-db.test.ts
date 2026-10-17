/**
 * Phase 14 voice agent retired (owner, 2026-10-08) — cleanup migration
 * supabase/migrations/20270102090000_voice_ears_cleanup.sql drops the dead `voice_ears` table and
 * its three service-role-only functions on a real Postgres. Needs SUPABASE_TEST_DB_URL (a local
 * stack); skipped without it. Every case applies the original migration, then the cleanup, inside
 * one transaction that is rolled back, so the shared stack is left exactly as it was.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const ORIGINAL_UP = readFileSync("supabase/migrations/20261117090000_voice_ears.sql", "utf8");
const CLEANUP_UP = readFileSync("supabase/migrations/20270102090000_voice_ears_cleanup.sql", "utf8");
const CLEANUP_DOWN = readFileSync(
  "supabase/migrations/down/20270102090000_voice_ears_cleanup.down.sql", "utf8");

const COUNTS = `select
    (select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = 'voice_ears')
    || ',' ||
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'voice_ears_open')
    || ',' ||
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'voice_ears_close')
    || ',' ||
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'voice_ears_refuse');`;

/** The original migration (idempotent: `if not exists` / `create or replace`), the cleanup
 *  migration, then `extra` statements — all inside one transaction, rolled back at the end so
 *  the stack's real state (whatever it was before this file ran) is unaffected afterward. */
function rolledBack(...extra: string[]): string {
  const sql = ["begin;", ORIGINAL_UP, CLEANUP_UP, ...extra, "rollback;"].join("\n");
  return runSql(sql);
}

describe.skipIf(!HAS_DB)("voice_ears cleanup migration (rolled back)", () => {
  it("drops the table and all three functions", () => {
    expect(rolledBack(COUNTS)).toBe("0,0,0,0");
  });

  it("is idempotent: running the cleanup twice still leaves everything dropped", () => {
    const sql = ["begin;", ORIGINAL_UP, CLEANUP_UP, CLEANUP_UP, COUNTS, "rollback;"].join("\n");
    expect(runSql(sql)).toBe("0,0,0,0");
  });

  it("the down file restores the table and all three functions", () => {
    const sql = ["begin;", ORIGINAL_UP, CLEANUP_UP, CLEANUP_DOWN, COUNTS, "rollback;"].join("\n");
    expect(runSql(sql)).toBe("1,1,1,1");
  });

  it("after the down file, the cleanup can be re-applied cleanly", () => {
    const sql = ["begin;", ORIGINAL_UP, CLEANUP_UP, CLEANUP_DOWN, CLEANUP_UP, COUNTS, "rollback;"]
      .join("\n");
    expect(runSql(sql)).toBe("0,0,0,0");
  });

  it("the down file restores RLS and the service-role-only grants", () => {
    expect(CLEANUP_DOWN).toContain("alter table voice_ears enable row level security");
    expect(CLEANUP_DOWN).toContain("alter table voice_ears force row level security");
    expect(CLEANUP_DOWN).toContain("revoke all on table voice_ears from anon, authenticated");
    expect(CLEANUP_DOWN).toContain("grant all on table voice_ears to service_role");
    for (const sig of ["voice_ears_open(uuid, integer, integer)",
      "voice_ears_close(uuid, uuid)", "voice_ears_refuse(uuid, uuid)"]) {
      expect(CLEANUP_DOWN).toContain(`revoke execute on function ${sig} from public, anon, authenticated`);
      expect(CLEANUP_DOWN).toContain(`grant execute on function ${sig} to service_role`);
    }
  });

  it("the cleanup migration sets a short lock_timeout (live-safe)", () => {
    expect(CLEANUP_UP).toContain("set local lock_timeout = '3s'");
  });
});
