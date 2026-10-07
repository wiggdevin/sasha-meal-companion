/**
 * T0 §1 — the `client_timings` migration and its down file.
 *
 * Static assertions over the SQL text, the pattern tests/migrations/policy-categories.test.ts
 * already uses: these files are applied by hand, so what CI can check is that the text says what
 * the plan says. The one detail worth spelling out is the grant shape — she INSERTS her own
 * marks and never reads them back; the p50/p95 tables are a service-role script's job.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TIMING_PATHS, TIMING_STEPS } from "@/lib/timing";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = sqlOnly(read("supabase/migrations/20261019090100_client_timings.sql"));
/** T7 §1 widened the step check by one; the vocabulary now lives across the pair. */
const DICTATION = sqlOnly(read("supabase/migrations/20261021090000_client_timings_dictation.sql"));
const DICTATION_DOWN =
  sqlOnly(read("supabase/migrations/down/20261021090000_client_timings_dictation.down.sql"));
const DOWN = sqlOnly(read("supabase/migrations/down/20261019090100_client_timings.down.sql"));

function effectiveVocabulary(column: "path" | "step"): string[] {
  const files = readdirSync(path.join(process.cwd(), "supabase/migrations"))
    .filter((file) => file.endsWith(".sql")).sort();
  let latest: string[] | null = null;
  const pattern = new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, "gis");
  for (const file of files) {
    const sql = sqlOnly(read(`supabase/migrations/${file}`));
    for (const match of sql.matchAll(pattern)) {
      latest = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    }
  }
  if (latest === null) throw new Error(`No client_timings ${column} constraint found`);
  return latest;
}

describe("20261019090100_client_timings", () => {
  it("creates the table T0 §1 names, keyed to auth.users and cascading on delete", () => {
    expect(UP).toContain("create table if not exists client_timings");
    expect(UP).toContain("references auth.users(id) on delete cascade");
    for (const column of ["run_id", "path", "step", "ms", "at", "device"]) {
      expect(UP).toContain(column);
    }
  });

  it("constrains path and step to the vocabulary lib/timing.ts exports", () => {
    expect(effectiveVocabulary("path")).toEqual([...TIMING_PATHS]);
    expect(effectiveVocabulary("step")).toEqual([...TIMING_STEPS]);
  });

  it("lets her insert her own rows and nothing else — no select policy, no update, no delete", () => {
    expect(UP).toContain("alter table client_timings enable row level security");
    expect(UP).toContain("for insert to authenticated");
    expect(UP).toContain("with check (user_id = (select auth.uid()))");
    expect(UP).toContain("revoke all on table client_timings from anon, authenticated");
    expect(UP).toContain("grant insert on table client_timings to authenticated");
    expect(UP).not.toMatch(/grant\s+select[^;]*to\s+authenticated/);
    expect(UP).not.toMatch(/for\s+(select|update|delete|all)\s+to\s+authenticated/);
  });

  it("gives the scripts' service-role client the read the pnpm timings report needs", () => {
    expect(UP).toContain("grant all on table client_timings to service_role");
  });

  it("indexes the two columns the report filters on", () => {
    expect(UP).toContain("create index if not exists client_timings_path_at");
  });

  it("20261021090000 widens the step check by `dictation` and touches nothing else", () => {
    expect(DICTATION).toContain("drop constraint if exists client_timings_step_check");
    expect(DICTATION).toContain("'dictation'");
    expect(DICTATION).not.toContain("drop table");
    expect(DICTATION).not.toContain("policy");
    expect(DICTATION_DOWN).not.toContain("'dictation','sent'");
    expect(DICTATION_DOWN).toContain("delete from client_timings where step = 'dictation'");
  });

  it("down drops the index, the policy and the table it created — nothing else", () => {
    expect(DOWN).toContain("drop index if exists client_timings_path_at");
    expect(DOWN).toContain("drop policy if exists client_timings_insert on client_timings");
    expect(DOWN).toContain("drop table if exists client_timings");
    expect(DOWN).not.toContain("auth.users");
    expect(DOWN).not.toContain("ai_calls");
  });
});
