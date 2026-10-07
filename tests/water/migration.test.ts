/**
 * T6 (bug batch 2026-09-12, F-01): the water goal becomes per day type.
 *
 * The two halves are deliberately different things (round-2 audit, P2). The migration's backfill
 * only ever runs at apply time, so the scenario that proves it — roll T6 back, seed a legacy row
 * through `_sync_upsert` with `water_goal_cups = 10`, apply T6, read both new columns — is
 * executed for real over psql (`runSql`), inside a transaction that is rolled back. The
 * PostgREST half covers the write path the backfill feeds: an insert that carries only the legacy
 * goal still lands on both day types, an old phone's payload that omits them keeps them, and an
 * explicit null is refused rather than defaulted. The text assertions left on the migration cover
 * what a live branch cannot show: statement order and the `= excluded` form being gone.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureUser, HAS_BRANCH, HAS_DB, resetUser, runSql, userClient }
  from "../helpers/supabase";

const NAME = "20261012090000_water_goal_by_day_type";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

describe(`${NAME}.sql`, () => {
  it("adds one goal per day type, both inside the column's check range", () => {
    expect(UP).toContain("add column water_goal_cups_training integer not null default 8");
    expect(UP).toContain("check (water_goal_cups_training between 1 and 30)");
    expect(UP).toContain("add column water_goal_cups_rest integer not null default 8");
    expect(UP).toContain("check (water_goal_cups_rest between 1 and 30)");
  });

  it("adds both columns before the single backfill update, and keeps the legacy column", () => {
    expect(UP).toContain("set water_goal_cups_training = water_goal_cups");
    expect(UP).toContain("water_goal_cups_rest = water_goal_cups");
    expect(UP.indexOf("add column water_goal_cups_training"))
      .toBeLessThan(UP.indexOf("update user_settings"));
    expect(UP).toContain("coalesce((p_payload->>'water_goal_cups')::integer, 8)");
    expect(UP).not.toContain("drop column water_goal_cups");
  });

  it("replaces _sync_upsert once, carrying both goals on the whole-row write", () => {
    expect(UP.match(/create or replace function _sync_upsert/g) ?? []).toHaveLength(1);
    expect(UP).toContain("water_goal_cups_training, water_goal_cups_rest, rev)");
    expect(UP).toContain("coalesce((p_payload->>'water_goal_cups_training')::integer,");
    expect(UP).toContain("coalesce((p_payload->>'water_goal_cups_rest')::integer,");
    expect(UP).toContain("revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer)");
  });

  // The contract T11b's four nullable columns copy: omitted = keep, null = clear/refuse. Without
  // key presence on the UPDATE side, an old phone's payload (which carries no split goal) resets
  // both to its legacy water_goal_cups — the driver watched 12/9 flip to 10/10 on the branch.
  it("keeps an omitted goal on update by key presence, and refuses an explicit null", () => {
    expect(UP).toContain("water_goal_cups_training = case when p_payload ? 'water_goal_cups_training'");
    expect(UP).toContain("then (p_payload->>'water_goal_cups_training')::integer");
    expect(UP).toContain("else user_settings.water_goal_cups_training end");
    expect(UP).toContain("water_goal_cups_rest = case when p_payload ? 'water_goal_cups_rest'");
    expect(UP).toContain("then (p_payload->>'water_goal_cups_rest')::integer");
    expect(UP).toContain("else user_settings.water_goal_cups_rest end");
    expect(UP).not.toContain("water_goal_cups_training = excluded.water_goal_cups_training");
    expect(UP).not.toContain("water_goal_cups_rest = excluded.water_goal_cups_rest");
    // The legacy column keeps its Phase 3 behaviour, as the audit fix requires.
    expect(UP).toContain("water_goal_cups = excluded.water_goal_cups");
    // A present JSON null on a not-null column is refused, never coalesced to a default.
    expect(UP).toContain("if p_payload ? 'water_goal_cups_training'");
    expect(UP).toContain("if p_payload ? 'water_goal_cups_rest'");
    expect(UP).toContain("raise exception 'water_goal_null:");
    expect(UP).toContain("errcode = '22023'");
    expect(UP.indexOf("raise exception 'water_goal_null:"))
      .toBeLessThan(UP.indexOf("insert into user_settings"));
  });

  it("down restores the Phase 3 _sync_upsert first, then drops only the new columns", () => {
    expect(DOWN).toContain("create or replace function _sync_upsert");
    expect(DOWN).toContain("drop column water_goal_cups_training");
    expect(DOWN).toContain("drop column water_goal_cups_rest");
    expect(DOWN).not.toContain("water_goal_cups_training = excluded");
    expect(DOWN).not.toContain("water_goal_null");
    expect(DOWN.indexOf("create or replace function _sync_upsert"))
      .toBeLessThan(DOWN.indexOf("drop column water_goal_cups_training"));
    expect(DOWN).not.toContain("drop table");
  });
});

/**
 * The real thing. A row only needs backfilling if it exists before the migration is applied, so
 * the transaction goes back first (`DOWN` restores the Phase 3 `_sync_upsert` and drops both new
 * columns), writes one legacy row through that older function, then applies `UP` and reads the
 * columns. It ends in ROLLBACK, so the branch is left exactly as it was. Every assertion is a
 * marker psql printed: a row the backfill never reached reports the column's default 8 instead
 * of 10, and fails here. Like the rest of this file it needs a branch already carrying T6
 * (`db push` / `db reset`), but not the fixed `_sync_upsert` — rolling T6 back supplies the
 * pre-T6 version it seeds with.
 */
const canRunSql = HAS_BRANCH && HAS_DB;

describe.skipIf(!canRunSql)("backfill of a row that predates the migration", () => {
  it("carries a legacy 10 cups onto both day-type goals", async () => {
    const user = await ensureUser("b");
    const payload = JSON.stringify({ first_opened_at: "2026-09-01T00:00:00.000Z",
      water_goal_cups: 10 });
    const scenario = [
      "begin;",
      DOWN,
      `delete from user_settings where user_id = '${user.id}';`,
      `select _sync_upsert('${user.id}', 'user_settings', 'settings', '${payload}'::jsonb, 1);`,
      // Before UP runs: only the legacy column of the three exists, and the row sits in it.
      `select 't6_pre_cols:' || count(*) from information_schema.columns
        where table_name = 'user_settings'
        and column_name in ('water_goal_cups', 'water_goal_cups_training', 'water_goal_cups_rest');`,
      `select 't6_seeded:' || water_goal_cups from user_settings where user_id = '${user.id}';`,
      UP,
      `select 't6_backfilled:' || water_goal_cups_training || '/' || water_goal_cups_rest
        from user_settings where user_id = '${user.id}';`,
      "rollback;",
    ].join("\n");

    const out = runSql(scenario);
    expect(out).toContain("t6_pre_cols:1");
    expect(out).toContain("t6_seeded:10");
    // Not the insert fallback: this row was written before the columns existed, so only the
    // migration's `update user_settings set … = water_goal_cups` can put 10 in both.
    expect(out).toContain("t6_backfilled:10/10");
  });
});

type Result = Record<string, unknown> & { status: string; rev: number };

async function op(
  client: SupabaseClient, userId: string, kind: "create" | "update", baseRev: number | null,
  payload: Record<string, unknown>,
): Promise<Result> {
  const { data, error } = await client.rpc("apply_sync_op", {
    p_user_id: userId,
    p_op: { op_id: randomUUID(), entity: "user_settings", entity_id: "settings", kind, base_rev: baseRev,
      payload, client_ts: new Date().toISOString() },
  });
  if (error) throw error;
  return data as Result;
}

/**
 * Read the settings row back through the sync protocol. `adminClient().from("user_settings")`
 * answers 42501 on a branch created with `db reset --db-url` (PostgREST's roles carry no table
 * grants there — unrelated to T6), while `sync_changes` is granted to `authenticated` and returns
 * the row jsonb every applied op wrote.
 */
async function readSettings(client: SupabaseClient, userId: string): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("sync_changes",
    { p_user_id: userId, p_since: 0, p_limit: 500 });
  if (error) throw error;
  const rows = (data ?? []) as { entity: string; entity_key: string;
    current: Record<string, unknown> | null }[];
  const last = rows.filter((r) => r.entity === "user_settings" && r.entity_key === "settings").at(-1);
  if (!last?.current) throw new Error("no user_settings change was logged");
  return last.current;
}

const run = HAS_BRANCH ? describe : describe.skip;

// The write path, not the backfill: every row here is created after the migration is installed,
// so what it proves is the insert fallback (`coalesce(split, legacy, 8)`) and then the update
// rule the audit fixed — an omitted key keeps the stored goal, an explicit null is refused.
run("a legacy-only settings row through _sync_upsert", () => {
  it("falls back to the legacy goal on insert, then keeps both against an old phone", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);

    // 1. A phone that predates T6: the whole row it writes carries only the legacy goal, so the
    // insert defaults both split goals from it. (The migration's backfill is the psql case above.)
    const created = await op(client, user.id, "create", null,
      { first_opened_at: "2026-09-01T00:00:00.000Z", water_goal_cups: 10 });
    expect(created.status).toBe("applied");
    expect(await readSettings(client, user.id)).toMatchObject({ water_goal_cups: 10,
      water_goal_cups_training: 10, water_goal_cups_rest: 10 });

    // 2. She diverges them from the new card.
    const diverged = await op(client, user.id, "update", created.rev,
      { water_goal_cups: 10, water_goal_cups_training: 12, water_goal_cups_rest: 9 });
    expect(diverged.status).toBe("applied");
    expect(await readSettings(client, user.id)).toMatchObject({ water_goal_cups_training: 12,
      water_goal_cups_rest: 9 });

    // 3. An old phone writes its row again, omitting both new keys: 12/9 must survive. Before the
    // fix this payload reset them to its legacy 10 on both day types.
    await op(client, user.id, "update", diverged.rev,
      { water_goal_cups: 10, training_kcal: 2400, rest_kcal: 2100, protein_g: 150 });
    expect(await readSettings(client, user.id)).toMatchObject({ water_goal_cups: 10,
      water_goal_cups_training: 12, water_goal_cups_rest: 9 });
  });

  it("refuses an explicit null goal instead of defaulting it", async () => {
    const user = await ensureUser("b");
    await resetUser(user.id);
    const client = await userClient(user);
    const created = await op(client, user.id, "create", null,
      { first_opened_at: "2026-09-01T00:00:00.000Z", water_goal_cups: 9 });
    expect(created.status).toBe("applied");

    await expect(op(client, user.id, "update", created.rev,
      { water_goal_cups: 9, water_goal_cups_rest: null }))
      .rejects.toThrow(/water_goal_null/);
    expect(await readSettings(client, user.id)).toMatchObject({ water_goal_cups_training: 9,
      water_goal_cups_rest: 9 });
  });
});

describe("runSql keeps the database password out of argv", () => {
  const URL_WITH_SECRET =
    "postgresql://postgres.abc:p%40ss%2Fword@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require";

  it("splits a connection URL into psql's PG* environment", async () => {
    const { pgEnvFromUrl } = await import("../helpers/supabase");
    expect(pgEnvFromUrl(URL_WITH_SECRET)).toEqual({
      PGHOST: "aws-0-us-west-1.pooler.supabase.com", PGPORT: "5432", PGDATABASE: "postgres",
      PGUSER: "postgres.abc", PGPASSWORD: "p@ss/word", PGSSLMODE: "require",
    });
  });

  it("spawns psql with the secret only in its environment, never on its argv", async () => {
    // Observe the real spawn: the helper's module-level HAS_DB reads the env at import, so the
    // env is stubbed, the module registry reset, and child_process mocked before the import.
    vi.stubEnv("SUPABASE_TEST_DB_URL", URL_WITH_SECRET);
    vi.resetModules();
    const execFileSync = vi.fn(() => "ok\n");
    vi.doMock("node:child_process", () => ({ execFileSync }));
    try {
      const { runSql } = await import("../helpers/supabase");
      expect(runSql("select 1")).toBe("ok");
      expect(execFileSync).toHaveBeenCalledTimes(1);
      const [bin, argv, opts] = execFileSync.mock.calls[0] as unknown as
        [string, string[], { env: Record<string, string> }];
      expect(bin).toBe("psql");
      expect(argv.join(" ")).not.toContain("postgresql://");
      expect(argv.join(" ")).not.toContain("p@ss/word");
      expect(argv.join(" ")).not.toContain("p%40ss");
      expect(opts.env.PGPASSWORD).toBe("p@ss/word");
      expect(opts.env.PGHOST).toBe("aws-0-us-west-1.pooler.supabase.com");
    } finally {
      vi.doUnmock("node:child_process");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
