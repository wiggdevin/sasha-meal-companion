/**
 * Scale S2, migration 20261218090000 `rate_limits`: the shared limiter's SQL. The text half runs in
 * every unit shard; the database half runs on the migrated local stack (SUPABASE_TEST_DB_URL and
 * the TEST API settings, the CI Integration job). Nothing here can reach production
 * (tests/tenancy/local-only).
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, adminClient, anonClient, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read("supabase/migrations/20261218090000_rate_limits.sql");
const DOWN = read("supabase/migrations/down/20261218090000_rate_limits.down.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

type Hit = { allowed: boolean; remaining: number; reset_at: string };

async function hit(key: string, limit: number, windowSeconds = 60): Promise<Hit> {
  const { data, error } = await adminClient().rpc("rate_limit_hit", {
    p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw new Error(error.message);
  return (data as Hit[])[0];
}

describe("20261218090000 rate_limits (text)", () => {
  it("is live-safe and service_role only", () => {
    for (const file of [UP, DOWN]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    expect(code(UP)).toContain("primary key (key, window_start)");
    expect(code(UP)).toContain("force row level security");
    expect(code(UP)).toContain("revoke all on table public.rate_limits from public, anon, authenticated");
    expect(code(UP)).toContain(
      "revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated");
    expect(code(UP)).toContain("grant execute on function public.rate_limit_hit(text, integer, integer) to service_role");
  });

  it("counts in one INSERT .. ON CONFLICT DO UPDATE .. RETURNING statement", () => {
    expect(code(UP)).toMatch(/insert into public\.rate_limits[\s\S]*?on conflict \(key, window_start\)\s+do update[\s\S]*?returning r\.count into v_count;/);
  });
});

describe.skipIf(!HAS_DB || !HAS_BRANCH)("20261218090000 rate_limits (database)", () => {
  it("allows exactly `limit` hits, then refuses, and reports remaining and the window's reset", async () => {
    const key = `test:seq:${crypto.randomUUID()}`;
    const hits = [];
    for (let i = 0; i < 5; i++) hits.push(await hit(key, 3));
    expect(hits.map((h) => h.allowed)).toEqual([true, true, true, false, false]);
    expect(hits.map((h) => h.remaining)).toEqual([2, 1, 0, 0, 0]);
    const reset = Date.parse(hits[0].reset_at);
    expect(reset).toBeGreaterThan(Date.now());
    expect(reset % 60_000).toBe(0);
    // The stored count stops at limit + 1, however long the flood.
    expect(runSql(`select count from public.rate_limits where key = '${key}'`)).toBe("4");
  });

  it("N parallel hits never allow more than the limit", async () => {
    const key = `test:par:${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 40 }, () => hit(key, 10)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("keys are independent: one caller's flood leaves another's window untouched", async () => {
    const [a, b] = [`test:a:${crypto.randomUUID()}`, `test:b:${crypto.randomUUID()}`];
    for (let i = 0; i < 3; i++) await hit(a, 2);
    expect((await hit(b, 2)).allowed).toBe(true);
  });

  it("a key's new window deletes its older windows; the sweep deletes other expired rows", async () => {
    const key = `test:old:${crypto.randomUUID()}`;
    const stale = `test:stale:${crypto.randomUUID()}`;
    runSql(`insert into public.rate_limits (key, window_start, count, expires_at) values
      ('${key}', now() - interval '2 hours', 5, now() - interval '1 hour'),
      ('${stale}', now() - interval '2 hours', 5, now() - interval '1 hour')`);
    await hit(key, 5);
    expect(runSql(`select count(*) from public.rate_limits where key = '${key}'`)).toBe("1");
    const { data, error } = await adminClient().rpc("rate_limits_sweep", { p_max: 5000 });
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
    expect(runSql(`select count(*) from public.rate_limits where key = '${stale}'`)).toBe("0");
  });

  it("refuses bad arguments", async () => {
    for (const args of [{ p_key: "", p_limit: 1, p_window_seconds: 60 },
      { p_key: "k", p_limit: 0, p_window_seconds: 60 }, { p_key: "k", p_limit: 1, p_window_seconds: 0 }]) {
      const { error } = await adminClient().rpc("rate_limit_hit", args);
      expect(error?.code).toBe("22023");
    }
  });

  it("no client role can call it or read the table", async () => {
    const rpc = await anonClient().rpc("rate_limit_hit", { p_key: "x", p_limit: 1, p_window_seconds: 60 });
    expect(rpc.error).not.toBeNull();
    for (const role of ["anon", "authenticated"]) {
      expect(runSql(`select has_function_privilege('${role}', 'public.rate_limit_hit(text,integer,integer)', 'execute')
        or has_function_privilege('${role}', 'public.rate_limits_sweep(integer)', 'execute')
        or has_table_privilege('${role}', 'public.rate_limits', 'select')`)).toBe("f");
    }
  });

  it("the down file reverses it and the up file re-applies (inside a rolled-back transaction)", () => {
    const out = runSql(`begin; ${DOWN}
      select to_regclass('public.rate_limits') is null; ${UP}
      select to_regclass('public.rate_limits') is not null; rollback;`);
    expect(out.split("\n").filter((line) => line === "t" || line === "f")).toEqual(["t", "t"]);
  });
});
