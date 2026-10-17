/**
 * W044 (scale step 4), migrations 20270105100000 (indexes, CONCURRENTLY) and 20270105100100
 * (bounded retention purges). The text half runs in every unit shard; the database half runs on
 * the migrated local stack (SUPABASE_TEST_DB_URL). Nothing here can reach production
 * (tests/tenancy/local-only).
 *
 * Acceptance: each purge deletes only rows past its window, at most p_max per call; the ai_calls
 * purge keeps a row whose spend hold is still unsettled (and lets it go once the hold settles) and
 * a row a coach message cites; no API role can call a purge.
 *
 * The purges run against the whole shared stack, so this file relies on `test:integration`
 * running files one at a time (--no-file-parallelism): in parallel, another file's cleanup of user
 * A's spend holds could release the hold this file's held call depends on.
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, userClient, type TestUser,
} from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const INDEXES = read("supabase/migrations/20270105100000_scale4_indexes_concurrently.sql");
const INDEXES_DOWN = read("supabase/migrations/down/20270105100000_scale4_indexes_concurrently.down.sql");
const UP = read("supabase/migrations/20270105100100_scale4_retention_purge.sql");
const DOWN = read("supabase/migrations/down/20270105100100_scale4_retention_purge.down.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const statements = (sql: string) => code(sql).split(";").map((s) => s.trim()).filter(Boolean);
const PURGES = ["client_timings_purge", "ai_calls_purge", "job_runs_purge", "recipe_plan_previews_purge"];

describe("20270105100000 scale4 indexes (text)", () => {
  it("holds nothing but CREATE INDEX CONCURRENTLY IF NOT EXISTS, outside any transaction", () => {
    const up = statements(INDEXES);
    expect(up.length).toBe(4);
    for (const s of up) expect(s).toMatch(/^create index concurrently if not exists /);
    expect(code(INDEXES)).not.toMatch(/\b(begin|commit|set local)\b/i);
    expect(code(INDEXES)).toContain("on public.ai_calls (provider, model_id, status, created_at)");
    expect(code(INDEXES)).toContain("on public.log_items (food_ref_id)");
  });

  it("the down file drops each one concurrently", () => {
    const down = statements(INDEXES_DOWN);
    expect(down.length).toBe(4);
    for (const s of down) expect(s).toMatch(/^drop index concurrently if exists public\./);
  });
});

describe("20270105100100 scale4 retention purge (text)", () => {
  it("is live-safe and reversible", () => {
    for (const file of [UP, DOWN]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    for (const fn of PURGES) {
      expect(code(DOWN)).toContain(`drop function if exists public.${fn}(integer);`);
      expect(code(UP)).toContain(`revoke all on function public.${fn}(integer) from public, anon, authenticated;`);
      expect(code(UP)).toContain(`grant execute on function public.${fn}(integer) to service_role;`);
    }
    expect(code(UP)).not.toMatch(/grant execute [^;]* to (anon|authenticated)/);
  });

  it("every purge is bounded, oldest first and SKIP LOCKED", () => {
    expect(code(UP).match(/limit greatest\(1, least\(coalesce\(p_max, 5000\), 20000\)\)/g)).toHaveLength(4);
    expect(code(UP).match(/skip locked/g)).toHaveLength(4);
  });
});

describe.skipIf(!HAS_DB || !HAS_BRANCH)("20270105100100 scale4 retention purge (database)", () => {
  let a: TestUser;
  const TAG = `w044-${crypto.randomUUID().slice(0, 8)}`;

  const purge = async (fn: string, max = 5000) => {
    const { data, error } = await adminClient().rpc(fn, { p_max: max });
    if (error) throw new Error(error.message);
    return Number(data);
  };
  const call = (days: number, reservation: string | null = null) => runSql(`insert into public.ai_calls
      (user_id, purpose, provider, model_id, sdk_version, created_at, spend_reservation_id)
    values ('${a.id}', '${TAG}', 'test', 'm', '1', now() - interval '${days} days',
      ${reservation ? `'${reservation}'` : "null"}) returning id`).split("\n")[0];
  // A zero-dollar hold that has not expired: it moves no cap another test reads, and no sweep
  // reconciles it while this file runs.
  const holds: string[] = [];
  const hold = (settled: boolean) => {
    const id = runSql(`insert into public.ai_spend_reservations
        (user_id, day, amount_usd, created_at, expires_at, settled_at, actual_usd, settled_by)
      values ('${a.id}', current_date, 0, now(), now() + interval '1 hour',
        ${settled ? "now(), 0, 'client'" : "null, null, null"}) returning id`).split("\n")[0];
    holds.push(id);
    return id;
  };
  const exists = (table: string, where: string) =>
    runSql(`select count(*) from public.${table} where ${where}`) === "1";
  const clear = () => runSql(`
    delete from public.coach_messages where user_id = '${a.id}' and content = '${TAG}';
    delete from public.coach_threads where user_id = '${a.id}' and title = '${TAG}';
    delete from public.ai_calls where purpose = '${TAG}';
    delete from public.ai_spend_reservations where id in (${holds.map((h) => `'${h}'`).join(", ") || "null"});
    delete from public.job_runs where job = '${TAG}';
    delete from public.recipe_plan_previews where user_id = '${a.id}' and proof ->> 'tag' = '${TAG}';
    delete from public.client_timings where device = '${TAG}';`);

  beforeAll(async () => {
    a = await ensureUser("a");
    clear();
  });
  afterAll(() => clear());

  it("ai_calls: keeps a call an unsettled hold names, and lets it go once the hold settles", async () => {
    const open = hold(false);
    const held = call(100, open);
    const settledCall = call(100, hold(true));
    const pruned = call(100, crypto.randomUUID());   // its hold was pruned long ago: not open
    const fresh = call(10);
    await purge("ai_calls_purge");
    expect(exists("ai_calls", `id = '${held}'`)).toBe(true);
    expect(exists("ai_calls", `id = '${settledCall}'`)).toBe(false);
    expect(exists("ai_calls", `id = '${pruned}'`)).toBe(false);
    expect(exists("ai_calls", `id = '${fresh}'`)).toBe(true);
    runSql(`update public.ai_spend_reservations set settled_at = now(), actual_usd = 0,
      settled_by = 'reconcile' where id = '${open}'`);
    await purge("ai_calls_purge");
    expect(exists("ai_calls", `id = '${held}'`)).toBe(false);
  });

  it("ai_calls: keeps a call a coach message cites (the reply's provenance)", async () => {
    const cited = call(120);
    const thread = runSql(`insert into public.coach_threads (user_id, title) values ('${a.id}', '${TAG}')
      returning id`).split("\n")[0];
    runSql(`insert into public.coach_messages (thread_id, user_id, role, seq, content, ai_call_id)
      values ('${thread}', '${a.id}', 'assistant', 1, '${TAG}', '${cited}')`);
    await purge("ai_calls_purge");
    expect(exists("ai_calls", `id = '${cited}'`)).toBe(true);
  });

  it("client_timings, job_runs and recipe_plan_previews go only past their windows, p_max at a time", async () => {
    runSql(`insert into public.client_timings (user_id, run_id, path, step, ms, device, created_at)
      select '${a.id}', gen_random_uuid(), 'barcode', 'decode', 1, '${TAG}', now() - make_interval(days => d)
        from (values (91), (95), (100), (89)) v(d)`);
    expect(await purge("client_timings_purge", 2)).toBeGreaterThanOrEqual(2);
    await purge("client_timings_purge");
    expect(runSql(`select count(*) from public.client_timings where device = '${TAG}'`)).toBe("1");

    runSql(`insert into public.job_runs (job, run_key, user_id, started_at, status)
      values ('${TAG}', 'old', '${a.id}', now() - interval '61 days', 'ok'),
             ('${TAG}', 'new', '${a.id}', now() - interval '59 days', 'ok')`);
    await purge("job_runs_purge");
    expect(runSql(`select string_agg(run_key, ',') from public.job_runs where job = '${TAG}'`)).toBe("new");
    runSql(`insert into public.job_runs (job, run_key, user_id, started_at, status)
      values ('weekly-proposal', '${TAG}', '${a.id}', now() - interval '400 days', 'ok')`);
    await purge("job_runs_purge");
    expect(runSql(`select count(*) from public.job_runs where job = 'weekly-proposal' and run_key = '${TAG}'`)).toBe("1");
    runSql(`delete from public.job_runs where job = 'weekly-proposal' and run_key = '${TAG}'`);

    runSql(`insert into public.recipe_plan_previews (user_id, kind, proof, state_rev, created_at, expires_at)
      values ('${a.id}', 'recipe', '{"tag": "${TAG}", "age": "old"}', 0, now() - interval '9 days',
              now() - interval '8 days'),
             ('${a.id}', 'recipe', '{"tag": "${TAG}", "age": "new"}', 0, now() - interval '6 days',
              now() - interval '6 days')`);
    await purge("recipe_plan_previews_purge");
    expect(runSql(`select string_agg(proof ->> 'age', ',') from public.recipe_plan_previews
      where user_id = '${a.id}' and proof ->> 'tag' = '${TAG}'`)).toBe("new");
  });

  it("no API role can call a purge", async () => {
    const asA = await userClient(a);
    for (const fn of PURGES) {
      const { error } = await asA.rpc(fn, { p_max: 1 });
      expect({ fn, code: error?.code }).toEqual({ fn, code: "42501" });
    }
  });
});
