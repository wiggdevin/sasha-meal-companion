/**
 * OD01, migration 20270103090000 `ai_spend_background_split`: background calls get their own daily
 * ceiling and never use an account's interactive reserve. The text half runs in every unit shard;
 * the database half runs on the migrated local stack (the CI Integration job). Nothing here can
 * reach production (tests/tenancy/local-only).
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, type TestUser } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read("supabase/migrations/20270103090000_ai_spend_background_split.sql");
const DOWN = read("supabase/migrations/down/20270103090000_ai_spend_background_split.down.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const SPLIT = "ai_spend_reserve_split(uuid, numeric, numeric, numeric, integer,\n  boolean, numeric, numeric)";

type Reserve = { reservation_id: string | null; allowed: boolean; reason: string | null };

async function reserve(user: string, amount: number, background: boolean,
  opts: { userCap?: number; backgroundCap?: number; interactiveReserve?: number } = {}): Promise<Reserve> {
  const { data, error } = await adminClient().rpc("ai_spend_reserve_split", { p_user_id: user,
    p_amount_usd: amount, p_user_cap_usd: opts.userCap ?? 2, p_global_cap_usd: 1000, p_ttl_seconds: 300,
    p_background: background, p_background_cap_usd: opts.backgroundCap ?? 10,
    p_interactive_reserve_usd: opts.interactiveReserve ?? 1 });
  if (error) throw new Error(error.message);
  return (data as Reserve[])[0];
}

describe("20270103090000 ai_spend_background_split (text)", () => {
  it("is live-safe and service_role only", () => {
    for (const file of [UP, DOWN]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    expect(code(UP)).toContain(`revoke all on function public.${SPLIT} from public, anon, authenticated;`);
    expect(code(UP)).toContain(`grant execute on function public.${SPLIT} to service_role;`);
    expect(code(UP)).toMatch(/add column background boolean not null default false;/);
  });

  it("keeps the old entry point as an interactive reservation, and reads every check in one statement", () => {
    expect(code(UP)).toMatch(/p_global_cap_usd, p_ttl_seconds, false, 0, 0\);/);
    const body = code(UP).slice(code(UP).indexOf("create function public.ai_spend_reserve_split"));
    expect(body).toContain("_ai_spend_lock_day(p_user_id, v_day, true)");
    const check = body.slice(body.indexOf("select u.spent_usd,"));
    const statement = check.slice(0, check.indexOf(";"));
    expect(statement).toMatch(/r\.background and r\.day = v_day and r\.user_id = p_user_id/);
    expect(statement).toMatch(/r\.background and r\.day = v_day\)/);
    expect(UP).toMatch(/APPLY TO PRODUCTION BEFORE THE CODE MERGES/);
  });
});

describe.skipIf(!HAS_DB || !HAS_BRANCH)("20270103090000 ai_spend_background_split (database)", () => {
  let a: TestUser;
  let b: TestUser;
  const clean = () => runSql(`delete from public.ai_spend_reservations where user_id in ('${a.id}', '${b.id}');
    delete from public.ai_spend_user_days where user_id in ('${a.id}', '${b.id}');
    delete from public.ai_spend_reservations where background;
    delete from public.ai_spend_global_days;
    insert into public.ai_spend_global_days (day, shard, spent_usd)
      select (now() at time zone 'utc')::date, g, 0 from generate_series(0, 15) g;
    insert into public.ai_spend_user_days (user_id, day, spent_usd) values
      ('${a.id}', (now() at time zone 'utc')::date, 0), ('${b.id}', (now() at time zone 'utc')::date, 0);`);

  beforeAll(async () => {
    a = await ensureUser("a");
    b = await ensureUser("b");
  });
  afterAll(() => { clean(); runSql(`delete from public.ai_spend_user_days where user_id in ('${a.id}', '${b.id}'); delete from public.ai_spend_global_days`); });

  it("background calls never use the account's interactive reserve; its own turns still can", async () => {
    clean();
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(a.id, 0.1, true)));
    // $2 cap less the $1 reserve: ten background holds, every other one refused for the reserve.
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === "background_user_cap")).toBe(true);
    const turns = await Promise.all(Array.from({ length: 12 }, () => reserve(a.id, 0.1, false)));
    expect(turns.filter((r) => r.allowed)).toHaveLength(10);
    expect(turns.filter((r) => !r.allowed).every((r) => r.reason === "user_cap")).toBe(true);
  });

  it("caps background calls across every account, counting settled actuals and open holds", async () => {
    clean();
    expect((await reserve(a.id, 0.5, true, { backgroundCap: 0.8 })).allowed).toBe(true);
    const over = await reserve(b.id, 0.4, true, { backgroundCap: 0.8 });
    expect(over).toMatchObject({ allowed: false, reason: "background_cap" });
    // Interactive calls never see the background ceiling.
    expect((await reserve(b.id, 0.4, false, { backgroundCap: 0.8 })).allowed).toBe(true);
    const held = runSql(`select id from public.ai_spend_reservations where background and user_id = '${a.id}'`);
    const { error } = await adminClient().rpc("ai_spend_settle", { p_reservation_id: held, p_actual_usd: 0.1 });
    expect(error).toBeNull();
    expect((await reserve(b.id, 0.4, true, { backgroundCap: 0.8 })).allowed).toBe(true);
  });

  it("the old five-argument entry point still reserves, as interactive", async () => {
    clean();
    const { data, error } = await adminClient().rpc("ai_spend_reserve", { p_user_id: a.id,
      p_amount_usd: 0.1, p_user_cap_usd: 2, p_global_cap_usd: 1000, p_ttl_seconds: 300 });
    expect(error).toBeNull();
    expect((data as Reserve[])[0].allowed).toBe(true);
    expect(runSql(`select bool_or(background) from public.ai_spend_reservations where user_id = '${a.id}'`)).toBe("f");
  });

  it("down then up re-applies (rolled back)", () => {
    const out = runSql(`begin; ${DOWN}
      select to_regprocedure('public.ai_spend_reserve_split(uuid,numeric,numeric,numeric,integer,boolean,numeric,numeric)') is null; ${UP}
      select to_regprocedure('public.ai_spend_reserve_split(uuid,numeric,numeric,numeric,integer,boolean,numeric,numeric)') is not null; rollback;`);
    expect(out.split("\n").filter((l) => l === "t" || l === "f")).toEqual(["t", "t"]);
  });
});
