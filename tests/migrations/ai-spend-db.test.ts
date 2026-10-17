/**
 * Scale S2, migration 20261218090100 `ai_spend_reservations`: the atomic spend reservation. The
 * text half runs in every unit shard; the database half runs on the migrated local stack (the CI
 * Integration job). Nothing here can reach production (tests/tenancy/local-only).
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, anonClient, ensureUser, runSql, type TestUser,
} from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read("supabase/migrations/20261218090100_ai_spend_reservations.sql");
const DOWN = read("supabase/migrations/down/20261218090100_ai_spend_reservations.down.sql");
const INDEXES = read("supabase/migrations/20261218090200_user_id_fk_indexes.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

type Reserve = { reservation_id: string | null; allowed: boolean; reason: string | null;
  user_committed_usd: number; global_committed_usd: number };

async function reserve(user: string, amount: number, userCap: number, globalCap: number): Promise<Reserve> {
  const { data, error } = await adminClient().rpc("ai_spend_reserve", { p_user_id: user,
    p_amount_usd: amount, p_user_cap_usd: userCap, p_global_cap_usd: globalCap, p_ttl_seconds: 300 });
  if (error) throw new Error(error.message);
  return (data as Reserve[])[0];
}

async function settle(id: string, actual: number): Promise<boolean> {
  const { data, error } = await adminClient().rpc("ai_spend_settle", {
    p_reservation_id: id, p_actual_usd: actual });
  if (error) throw new Error(error.message);
  return data as boolean;
}

describe("20261218090100 ai_spend_reservations (text)", () => {
  it("is live-safe and service_role only", () => {
    for (const file of [UP, DOWN, INDEXES]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    for (const fn of ["ai_spend_reserve(uuid, numeric, numeric, numeric, integer)",
      "ai_spend_settle(uuid, numeric)", "ai_spend_sweep(integer)"]) {
      expect(code(UP)).toContain(`revoke all on function public.${fn}`);
    }
    expect(code(UP)).toMatch(/from public, anon, authenticated;/);
  });

  it("locks the global day row before the user's, and reserve runs no sweep", () => {
    const lock = code(UP).slice(code(UP).indexOf("create function public._ai_spend_lock_day"));
    expect(lock.indexOf("_ai_spend_shard(p_user_id) for update")).toBeGreaterThan(-1);
    expect(lock.indexOf("ai_spend_global_days")).toBeLessThan(lock.indexOf("ai_spend_user_days"));
    for (const fn of ["ai_spend_reserve", "ai_spend_settle", "ai_spend_sweep"]) {
      const body = code(UP).slice(code(UP).indexOf(`create function public.${fn}`));
      expect(body).toContain("_ai_spend_lock_day(");
    }
    const reserveBody = code(UP).slice(code(UP).indexOf("create function public.ai_spend_reserve"),
      code(UP).indexOf("create function public.ai_spend_settle"));
    expect(reserveBody).not.toMatch(/ai_spend_sweep/);
    expect(UP).toContain("a cap can be exceeded by at most one call's overrun beyond its estimate");
    // The global check reads every shard and every open hold in ONE statement (one snapshot).
    const check = reserveBody.slice(reserveBody.indexOf("select u.spent_usd,"));
    const statement = check.slice(0, check.indexOf(";"));
    expect(statement).toMatch(/ai_spend_global_days/);
    expect(statement).toMatch(/r\.day = v_day and r\.settled_at is null/);
    expect(reserveBody.match(/from public\.ai_spend_global_days/g)).toHaveLength(2);
  });

  it("indexes all nine flagged user_id keys, IF NOT EXISTS, with the no-CONCURRENTLY note", () => {
    for (const t of ["api_tokens", "client_timings", "favorites_meals", "ingest_events", "job_runs",
      "media_objects", "oauth_states", "recipes", "target_profiles"]) {
      expect(code(INDEXES)).toContain(`create index if not exists ${t}_user_id on public.${t} (user_id);`);
    }
    expect(INDEXES).toMatch(/not CONCURRENTLY/i);
  });
});

describe("20270104140000 ai_spend_seed_unreserved (text)", () => {
  const SEED = read("supabase/migrations/20270104140000_ai_spend_seed_unreserved.sql");
  const SEED_DOWN = read("supabase/migrations/down/20270104140000_ai_spend_seed_unreserved.down.sql");

  it("seeds the global and user rows from unreserved ai_calls only, and the down restores both reads", () => {
    for (const file of [SEED, SEED_DOWN]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    expect(code(SEED).match(/c\.spend_reservation_id is null/g)).toHaveLength(2);
    expect(code(SEED)).toContain("create or replace function public._ai_spend_lock_day");
    expect(code(SEED_DOWN)).not.toContain("spend_reservation_id");
  });
});

describe.skipIf(!HAS_DB || !HAS_BRANCH)("20261218090100 ai_spend_reservations (database)", () => {
  let a: TestUser;
  let b: TestUser;
  const clean = () => runSql(`delete from public.ai_spend_reservations where user_id in ('${a.id}', '${b.id}');
    delete from public.ai_spend_user_days where user_id in ('${a.id}', '${b.id}');
    delete from public.ai_calls where user_id in ('${a.id}', '${b.id}') and purpose = 'spend-db-test';
    delete from public.ai_spend_global_days;
    -- Day rows start at zero, so other suites' ai_calls rows today never seed these cases.
    insert into public.ai_spend_global_days (day, shard, spent_usd)
      select (now() at time zone 'utc')::date, g, 0 from generate_series(0, 15) g;
    insert into public.ai_spend_user_days (user_id, day, spent_usd) values
      ('${a.id}', (now() at time zone 'utc')::date, 0), ('${b.id}', (now() at time zone 'utc')::date, 0);`);

  beforeAll(async () => {
    a = await ensureUser("a");
    b = await ensureUser("b");
  });
  afterAll(() => { clean(); runSql(`delete from public.ai_spend_user_days where user_id in ('${a.id}', '${b.id}'); delete from public.ai_spend_global_days`); });

  it("parallel reservations never let one user's holds pass the user cap", async () => {
    clean();
    const results = await Promise.all(Array.from({ length: 30 }, () => reserve(a.id, 0.1, 1, 1000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === "user_cap")).toBe(true);
  });

  it("parallel reservations from two users pass the global ceiling by at most the in-flight holds", async () => {
    clean();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      reserve(i % 2 ? a.id : b.id, 0.1, 1000, 1)));
    // One locked shard per user: each other shard can have one reservation in flight unseen.
    const shards = Number(runSql(`select count(distinct public._ai_spend_shard(u))
      from unnest(array['${a.id}'::uuid, '${b.id}'::uuid]) u`));
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBeGreaterThanOrEqual(10);
    expect(allowed).toBeLessThanOrEqual(10 + (shards - 1));
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === "global_cap")).toBe(true);
  });

  it("settle releases the difference, once; a second settle is a no-op", async () => {
    clean();
    const held = await reserve(a.id, 0.8, 1, 1000);
    expect(held.allowed).toBe(true);
    expect((await reserve(a.id, 0.3, 1, 1000)).allowed).toBe(false);
    expect(await settle(held.reservation_id as string, 0.2)).toBe(true);
    expect(await settle(held.reservation_id as string, 0.9)).toBe(false);
    const after = await reserve(a.id, 0.3, 1, 1000);
    expect(after.allowed).toBe(true);
    expect(Number(after.user_committed_usd)).toBeCloseTo(0.5, 6);
    expect(runSql(`select spent_usd from public.ai_spend_user_days where user_id = '${a.id}'`)).toBe("0.2");
  });

  const spent = (user: TestUser) =>
    Number(runSql(`select spent_usd from public.ai_spend_user_days where user_id = '${user.id}'
      and day = (now() at time zone 'utc')::date`));
  const expire = (id: string | null) => runSql(`update public.ai_spend_reservations
    set expires_at = now() - interval '1 second' where id = '${id}'`);
  const sweep = async () => {
    const { error } = await adminClient().rpc("ai_spend_sweep", { p_max: 2000 });
    if (error) throw new Error(error.message);
  };

  it("an actual cost over the hold is recorded in full, and the next reserve refuses", async () => {
    clean();
    const held = await reserve(a.id, 0.5, 1, 1000);
    expect(await settle(held.reservation_id as string, 1.2)).toBe(true);
    expect(spent(a)).toBeCloseTo(1.2, 6);
    // Spent has reached the cap: even a zero estimate is refused.
    expect((await reserve(a.id, 0, 1, 1000)).reason).toBe("user_cap");
    expect((await reserve(a.id, 0.01, 1, 1000)).reason).toBe("user_cap");
  });

  const ledgerRow = (user: TestUser, id: string | null, cost: number) => runSql(`insert into
    public.ai_calls (user_id, purpose, provider, model_id, sdk_version, cost_estimate,
    spend_reservation_id) values ('${user.id}', 'spend-db-test', 'test', 'm', '1', ${cost}, '${id}')`);

  it("a user's own abandoned holds that fill the cap are reconciled by their next reserve", async () => {
    clean();
    const holds = [await reserve(a.id, 0.5, 1, 1000), await reserve(a.id, 0.5, 1, 1000)];
    expect((await reserve(a.id, 0.1, 1, 1000)).reason).toBe("user_cap");
    // The functions crashed after their calls were written but before settling.
    for (const h of holds) { ledgerRow(a, h.reservation_id, 0.05); expire(h.reservation_id); }
    const next = await reserve(a.id, 0.1, 1, 1000);
    expect(next.allowed).toBe(true);
    expect(spent(a)).toBeCloseTo(0.1, 6);
    expect(runSql(`select string_agg(distinct settled_by, ',') from public.ai_spend_reservations
      where id in ('${holds[0].reservation_id}', '${holds[1].reservation_id}')`)).toBe("reconcile");
  });

  it("an abandoned hold with no ledger row is charged in full, so it still counts as spent", async () => {
    clean();
    const held = await reserve(a.id, 0.9, 1, 1000);
    expire(held.reservation_id);
    expect((await reserve(a.id, 0.5, 1, 1000)).reason).toBe("user_cap");
    expect(spent(a)).toBeCloseTo(0.9, 6);
  });

  it("other users' abandoned holds that fill the global ceiling are cleared by the sweep", async () => {
    clean();
    const holds = await Promise.all([0, 1, 2].map(() => reserve(b.id, 0.3, 1000, 1)));
    expect(holds.every((h) => h.allowed)).toBe(true);
    expect((await reserve(a.id, 0.2, 1000, 1)).reason).toBe("global_cap");
    for (const h of holds) { ledgerRow(b, h.reservation_id, 0.01); expire(h.reservation_id); }
    // A's own reserve does not reconcile B's holds; the cron's sweep does.
    expect((await reserve(a.id, 0.2, 1000, 1)).reason).toBe("global_cap");
    expect(Number(runSql("select public.ai_spend_expired_count()"))).toBeGreaterThanOrEqual(3);
    await sweep();
    expect(Number(runSql("select public.ai_spend_expired_count()"))).toBe(0);
    expect((await reserve(a.id, 0.2, 1000, 1)).allowed).toBe(true);
  });

  it("a settle on another shard can never let a reserve pass once spend + holds reach the ceiling", async () => {
    clean();
    // B holds the whole ceiling in ten pieces; each settles to exactly its hold, so at every
    // instant settled + open == ceiling. A reserve that read spend and holds in two snapshots
    // could see a piece as neither and pass; one statement never can.
    const pieces = await Promise.all(Array.from({ length: 10 }, () => reserve(b.id, 0.1, 1000, 1)));
    expect(pieces.every((p) => p.allowed)).toBe(true);
    const results = await Promise.all([
      ...pieces.map((p) => settle(p.reservation_id as string, 0.1).then(() => null)),
      ...Array.from({ length: 60 }, () => reserve(a.id, 0.001, 1000, 1)),
    ]);
    const passed = results.filter((r) => r !== null && (r as Reserve).allowed);
    expect(passed).toEqual([]);
  });

  it("history: an old hold is reconciled before its day goes, and never re-seeds a pruned day", async () => {
    const old = "2020-02-02";
    const purge = () => runSql(`delete from public.ai_spend_reservations where day = '${old}';
      delete from public.ai_spend_user_days where day = '${old}';
      delete from public.ai_spend_global_days where day = '${old}';
      delete from public.ai_calls where purpose = 'spend-db-old'`);
    purge();
    runSql(`insert into public.ai_spend_global_days (day, shard, spent_usd)
        select '${old}', g, 0 from generate_series(0, 15) g;
      insert into public.ai_spend_user_days (user_id, day, spent_usd) values ('${a.id}', '${old}', 0);
      insert into public.ai_spend_reservations (id, user_id, day, amount_usd, created_at, expires_at)
        values ('00000000-0000-4000-8000-000000000001', '${a.id}', '${old}', 0.4,
                now() - interval '1 hour', now() - interval '30 minutes')`);
    // While the hold is open its day rows stay, and the hold is charged before anything is pruned.
    await sweep();
    expect(runSql(`select settled_by || ':' || actual_usd from public.ai_spend_reservations
      where day = '${old}'`)).toBe("reconcile:0.4");
    expect(runSql(`select spent_usd from public.ai_spend_user_days where day = '${old}' and user_id = '${a.id}'`)).toBe("0.4");
    // Once the settled hold is old enough to prune (> 2 days), it goes, and then its day rows.
    runSql(`update public.ai_spend_reservations set created_at = '${old}T10:00:00Z' where day = '${old}'`);
    await sweep();
    expect(runSql(`select count(*) from public.ai_spend_reservations where day = '${old}'`)).toBe("0");
    expect(runSql(`select count(*) from public.ai_spend_user_days where day = '${old}'`)).toBe("0");
    expect(runSql(`select count(*) from public.ai_spend_global_days where day = '${old}'`)).toBe("0");
    // A stray hold for a day already pruned is reconciled without re-creating (and re-seeding) it.
    runSql(`insert into public.ai_calls (user_id, purpose, provider, model_id, sdk_version, cost_estimate,
        created_at) values ('${a.id}', 'spend-db-old', 'test', 'm', '1', 5, '${old}T09:00:00Z');
      insert into public.ai_spend_reservations (user_id, day, amount_usd, created_at, expires_at)
        values ('${a.id}', '${old}', 0.4, now() - interval '1 hour', now() - interval '30 minutes')`);
    await sweep();
    expect(runSql(`select settled_by from public.ai_spend_reservations where day = '${old}'`)).toBe("reconcile");
    expect(runSql(`select count(*) from public.ai_spend_user_days where day = '${old}'`)).toBe("0");
    expect(runSql(`select count(*) from public.ai_spend_global_days where day = '${old}'`)).toBe("0");
    purge();
  });

  it("the sweep charges the call's ai_calls cost when a row names the reservation", async () => {
    clean();
    const held = await reserve(a.id, 0.9, 1, 1000);
    runSql(`insert into public.ai_calls (user_id, purpose, provider, model_id, sdk_version,
      cost_estimate, spend_reservation_id) values ('${a.id}', 'spend-db-test', 'test', 'm', '1', 0.3,
      '${held.reservation_id}')`);
    expire(held.reservation_id);
    await sweep();
    expect(spent(a)).toBeCloseTo(0.3, 6);
    expect((await reserve(a.id, 0.6, 1, 1000)).allowed).toBe(true);
  });

  it("the sweep charges the whole hold when no row names it; a late settle adjusts to the actual", async () => {
    clean();
    const held = await reserve(a.id, 0.9, 1, 1000);
    expire(held.reservation_id);
    await sweep();
    expect(spent(a)).toBeCloseTo(0.9, 6);
    expect(await settle(held.reservation_id as string, 0.25)).toBe(true);
    expect(spent(a)).toBeCloseTo(0.25, 6);
    // A second client settle and a second sweep change nothing.
    expect(await settle(held.reservation_id as string, 0.8)).toBe(false);
    await sweep();
    expect(spent(a)).toBeCloseTo(0.25, 6);
  });

  it("settle then sweep: the sweep leaves a settled hold alone", async () => {
    clean();
    const held = await reserve(a.id, 0.9, 1, 1000);
    expect(await settle(held.reservation_id as string, 0.4)).toBe(true);
    expire(held.reservation_id);
    await sweep();
    expect(spent(a)).toBeCloseTo(0.4, 6);
  });

  it("benchmark: 100 parallel reserve + settle pairs (p50/p95/max logged)", async () => {
    clean();
    const pair = async (i: number) => {
      const started = performance.now();
      const r = await reserve(i % 2 ? a.id : b.id, 0.001, 1000, 1000);
      await settle(r.reservation_id as string, 0.0005);
      return performance.now() - started;
    };
    const baseline = async () => {
      const started = performance.now();
      const { error } = await adminClient().rpc("rate_limit_hit", {
        p_key: `bench:${crypto.randomUUID()}`, p_limit: 5, p_window_seconds: 60 });
      if (error) throw new Error(error.message);
      const { error: e2 } = await adminClient().rpc("rate_limit_hit", {
        p_key: `bench:${crypto.randomUUID()}`, p_limit: 5, p_window_seconds: 60 });
      if (e2) throw new Error(e2.message);
      return performance.now() - started;
    };
    await Promise.all(Array.from({ length: 10 }, (_, i) => pair(i)));
    const stats = (xs: number[]) => {
      const sorted = [...xs].sort((x, y) => x - y);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) };
    };
    const spend = stats(await Promise.all(Array.from({ length: 100 }, (_, i) => pair(i))));
    const base = stats(await Promise.all(Array.from({ length: 100 }, () => baseline())));
    console.log("ai_spend reserve+settle x100 parallel (ms)", spend,
      "| two uncontended rate_limit_hit calls x100 parallel (ms)", base);
    expect(spent(a) + spent(b)).toBeCloseTo(0.0005 * 110, 6);
  });

  it("seeds a new day row from that day's ai_calls, and a zero cap is the kill switch", async () => {
    clean();
    runSql(`delete from public.ai_spend_user_days where user_id = '${b.id}'`);
    runSql(`delete from public.ai_calls where user_id = '${b.id}'`);
    runSql(`insert into public.ai_calls (user_id, purpose, provider, model_id, sdk_version, cost_estimate)
      values ('${b.id}', 'spend-db-test', 'test', 'm', '1', 0.95)`);
    const r = await reserve(b.id, 0.1, 1, 1000);
    expect(r).toMatchObject({ allowed: false, reason: "user_cap" });
    expect(Number(r.user_committed_usd)).toBeCloseTo(0.95, 6);
    expect((await reserve(a.id, 0.01, 0, 1000)).reason).toBe("user_cap");
  });

  // W068, migration 20270104140000: a call that reserved before UTC midnight and logged after it
  // is charged to the day it reserved on, so the new day's seed must not count it again.
  it("seeds a new day only from ai_calls rows with no reservation (UTC midnight)", () => {
    clean();
    const day = "2020-01-02";
    runSql(`delete from public.ai_spend_user_days where user_id = '${b.id}' and day = '${day}';
      delete from public.ai_spend_global_days where day = '${day}';
      delete from public.ai_calls where user_id = '${b.id}';
      insert into public.ai_calls (user_id, purpose, provider, model_id, sdk_version, cost_estimate,
        created_at, spend_reservation_id) values
        ('${b.id}', 'spend-db-test', 'test', 'm', '1', 0.40, '${day} 00:05:00+00', gen_random_uuid()),
        ('${b.id}', 'spend-db-test', 'test', 'm', '1', 0.10, '${day} 00:06:00+00', null)`);
    const out = runSql(`select user_spent from public._ai_spend_lock_day('${b.id}', date '${day}', true)`);
    expect(Number(out.trim())).toBeCloseTo(0.1, 6);
    const global = runSql(`select sum(spent_usd) from public.ai_spend_global_days where day = '${day}'`);
    expect(Number(global.trim())).toBeCloseTo(0.1, 6);
    runSql(`delete from public.ai_calls where user_id = '${b.id}' and purpose = 'spend-db-test';
      delete from public.ai_spend_user_days where user_id = '${b.id}' and day = '${day}';
      delete from public.ai_spend_global_days where day = '${day}'`);
  });

  it("no client role can reserve, settle or read the tables", async () => {
    const rpc = await anonClient().rpc("ai_spend_reserve", { p_user_id: a.id, p_amount_usd: 0,
      p_user_cap_usd: 1, p_global_cap_usd: 1, p_ttl_seconds: 300 });
    expect(rpc.error).not.toBeNull();
    for (const role of ["anon", "authenticated"]) {
      expect(runSql(`select bool_or(x) from (values
        (has_function_privilege('${role}', 'public.ai_spend_reserve(uuid,numeric,numeric,numeric,integer)', 'execute')),
        (has_function_privilege('${role}', 'public.ai_spend_settle(uuid,numeric)', 'execute')),
        (has_function_privilege('${role}', 'public.ai_spend_sweep(integer)', 'execute')),
        (has_table_privilege('${role}', 'public.ai_spend_reservations', 'select')),
        (has_table_privilege('${role}', 'public.ai_spend_user_days', 'select')),
        (has_table_privilege('${role}', 'public.ai_spend_global_days', 'select'))) v(x)`)).toBe("f");
    }
  });

  it("the sweep removes old settled reservations; down then up re-applies (rolled back)", async () => {
    runSql(`insert into public.ai_spend_reservations (user_id, day, amount_usd, created_at, expires_at,
      settled_at, actual_usd, settled_by) values ('${a.id}', '2020-01-01', 0.1, now() - interval '3 days',
      now() - interval '3 days', now() - interval '3 days', 0.1, 'client')`);
    const { data, error } = await adminClient().rpc("ai_spend_sweep", { p_max: 5000 });
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
    expect(runSql(`select count(*) from public.ai_spend_reservations where day = '2020-01-01'`)).toBe("0");
    const out = runSql(`begin; ${DOWN}
      select to_regclass('public.ai_spend_reservations') is null; ${UP}
      select to_regclass('public.ai_spend_reservations') is not null; rollback;`);
    expect(out.split("\n").filter((l) => l === "t" || l === "f")).toEqual(["t", "t"]);
  });

  it("every flagged user_id key now has an index leading with user_id", () => {
    const uncovered = runSql(`select string_agg(t, ',') from unnest(array['api_tokens','client_timings',
      'favorites_meals','ingest_events','job_runs','media_objects','oauth_states','recipes',
      'target_profiles']) t where not exists (select 1 from pg_index i join pg_class c on c.oid = i.indrelid
      join pg_attribute att on att.attrelid = c.oid and att.attnum = i.indkey[0]
      where c.relname = t and c.relnamespace = 'public'::regnamespace and att.attname = 'user_id')`);
    expect(uncovered).toBe("");
  });
});
