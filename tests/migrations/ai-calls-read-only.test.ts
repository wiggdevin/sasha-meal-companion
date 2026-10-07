// The spend ledger is server-written. A user who could delete or zero her own ai_calls rows
// reset the daily spend cap, the circuit breaker and the capture caps (audit 2026-10-01).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = sqlOnly(read("supabase/migrations/20261206090000_ai_calls_read_only.sql"));
const DOWN = sqlOnly(read("supabase/migrations/down/20261206090000_ai_calls_read_only.down.sql"));

describe("20261206090000_ai_calls_read_only", () => {
  it("replaces the FOR ALL owner policy with a select-only one", () => {
    expect(UP).toContain("drop policy if exists ai_calls_rw on ai_calls");
    expect(UP).toMatch(/create policy ai_calls_read on ai_calls for select to authenticated/);
    expect(UP).toContain("using (user_id = (select auth.uid()))");
    expect(UP).not.toMatch(/for (all|insert|update|delete)/);
  });

  it("revokes every write grant from the client roles and grants none back", () => {
    expect(UP).toContain("revoke insert, update, delete on table ai_calls from anon, authenticated");
    expect(UP).not.toMatch(/\bgrant\b/);
  });

  it("down restores the Phase 0 shape", () => {
    expect(DOWN).toContain("drop policy if exists ai_calls_read on ai_calls");
    expect(DOWN).toContain("create policy ai_calls_rw on ai_calls for all to authenticated");
    expect(DOWN).toContain("grant insert, update, delete on table ai_calls to authenticated");
  });
});
