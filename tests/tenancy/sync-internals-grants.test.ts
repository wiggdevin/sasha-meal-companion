/**
 * Phase 9 security fix (P9 sync RPC grants). `_sync_current`, `_sync_upsert` and `_sync_tombstone`
 * are SECURITY DEFINER, take the owner as `p_user_id`, and before 20261103090000 never compared it
 * with auth.uid(). Their migrations revoked EXECUTE only from `public` and `anon`, and Supabase's
 * default privileges grant it to `authenticated` directly, so any signed-in user could call them
 * over PostgREST with another user's id: read, overwrite and tombstone that user's rows.
 *
 * The fix has two layers, and both are checked here:
 *   1. `authenticated` loses EXECUTE on all three (the durable layer: a grant survives a later
 *      `create or replace`).
 *   2. Each function asserts `_sync_assert_caller(p_user_id)` first (defense in depth for any
 *      future grant; the service role and the owner have no auth.uid() and pass).
 * The only SQL caller, apply_sync_op, is SECURITY DEFINER and already asserts the same caller, so
 * normal sync keeps working — the last block proves that for user A.
 */
// Refuses any non-local database before anything else runs (PR #247 review r9).
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, userClient, type TestUser,
} from "../helpers/supabase";

const MIGRATION = "20261103090000_sync_internals_revoke_authenticated";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (text: string) =>
  text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const SIGNATURES = [
  "_sync_current(uuid, text, text)",
  "_sync_upsert(uuid, text, text, jsonb, integer)",
  "_sync_tombstone(uuid, text, text, text, integer)",
];

describe(`${MIGRATION} (static)`, () => {
  const UP = sqlOnly(read(`supabase/migrations/${MIGRATION}.sql`));
  const DOWN = sqlOnly(read(`supabase/migrations/down/${MIGRATION}.down.sql`));

  it("revokes EXECUTE from authenticated on all three internals", () => {
    for (const sig of SIGNATURES) {
      expect(UP).toContain(`revoke execute on function public.${sig} from public, anon, authenticated;`);
    }
  });

  it("keeps the service role able to run them", () => {
    for (const sig of SIGNATURES) {
      expect(UP).toContain(`grant execute on function public.${sig} to service_role;`);
    }
  });

  it("adds the caller guard to each function body, idempotently", () => {
    expect(UP).toContain("perform _sync_assert_caller(p_user_id);");
    expect(UP).toContain("p9_sync_caller_guard");
    // Skips a function that already carries the marker, so a re-run changes nothing.
    expect(UP).toMatch(/position\('p9_sync_caller_guard' in definition\) > 0/);
  });

  it("down removes the guard but never re-grants authenticated", () => {
    expect(DOWN).toContain("p9_sync_caller_guard");
    expect(DOWN).not.toMatch(/grant execute[^;]*authenticated/);
  });
});

describe.skipIf(!HAS_DB)("sync internals privileges (spec 3.3)", () => {
  it("authenticated may not execute any _sync_ internal that takes a user id", () => {
    const out = runSql(
      "select p.oid::regprocedure || '=' || has_function_privilege('authenticated', p.oid, 'execute') " +
      "from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
      "where n.nspname = 'public' and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone') " +
      "order by 1;",
    );
    expect(out.split("\n")).toEqual([
      "_sync_current(uuid,text,text)=false",
      "_sync_tombstone(uuid,text,text,text,integer)=false",
      "_sync_upsert(uuid,text,text,jsonb,integer)=false",
    ]);
  });

  it("the in-function guard refuses another user's id even without the grant layer", () => {
    // Runs as the owner (the grant layer does not apply) with A's JWT claims, as a definer caller
    // would see them, and asks for B's row: the guard alone must refuse.
    const a = "00000000-0000-4000-8000-0000000000a1";
    const b = "00000000-0000-4000-8000-0000000000b2";
    const calls = [
      `_sync_current('${b}', 'water_log', '2041-01-01')`,
      `_sync_upsert('${b}', 'water_log', '2041-01-01', '{"cups":1}'::jsonb, 1)`,
      `_sync_tombstone('${b}', 'user_foods', '${b}', 'delete', 2)`,
    ];
    // _sync_assert_caller raises 'forbidden' with errcode 42501 (insufficient_privilege). Each
    // call records whether it was refused; the transaction rolls back, so nothing is written.
    const out = runSql([
      "begin;",
      `select set_config('request.jwt.claims', '{"sub":"${a}","role":"authenticated"}', true);`,
      "create temp table guard_result (fn text, ok boolean) on commit drop;",
      ...calls.map((call, i) => [
        "do $t$ begin",
        `  perform ${call};`,
        `  insert into guard_result values ('${i}', false);`,
        `exception when insufficient_privilege then insert into guard_result values ('${i}', true);`,
        "end $t$;",
      ].join("\n")),
      "select string_agg(fn || ':' || ok, ',' order by fn) from guard_result;",
      "rollback;",
    ].join("\n"));
    expect(out.split("\n")).toContain("0:true,1:true,2:true");
  });
});

describe.skipIf(!(HAS_DB && HAS_BRANCH))(`${MIGRATION} applied again (idempotency)`, () => {
  const UP_RAW = read(`supabase/migrations/${MIGRATION}.sql`);
  const DOWN_RAW = read(`supabase/migrations/down/${MIGRATION}.down.sql`);
  const GUARD_COUNT =
    "select '%s:' || string_agg(p.proname || '=' || (select count(*) from regexp_matches(" +
    "p.prosrc, 'p9_sync_caller_guard', 'g')), ',' order by p.proname) from pg_proc p " +
    "join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' " +
    "and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone');";
  const AUTH_EXEC =
    "select '%s:' || bool_or(has_function_privilege('authenticated', p.oid, 'execute')) " +
    "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' " +
    "and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone');";
  const ONE_EACH = "_sync_current=1,_sync_tombstone=1,_sync_upsert=1";

  it("a second forward run (and down + up + up) keeps one guard per function and the revoke", async () => {
    const a = await ensureUser("a");
    const b = await ensureUser("b");
    const date = day().replace("2042", "2043"); // a year no committed test row uses
    const claims = (sub: string) =>
      `select set_config('request.jwt.claims', '{"sub":"${sub}","role":"authenticated"}', true);`;
    const syncOp = (kind: string, baseRev: string, cups: number) =>
      `select '%s:' || (apply_sync_op('${a.id}', jsonb_build_object('op_id', gen_random_uuid(), ` +
      `'entity', 'water_log', 'entity_id', '${date}', 'kind', '${kind}', 'base_rev', ${baseRev}, ` +
      `'payload', jsonb_build_object('cups', ${cups}), 'client_ts', now()))->>'status');`;
    const tag = (sql: string, t: string) => sql.replace("%s", t);
    const out = runSql([
      "begin;",
      UP_RAW,
      tag(GUARD_COUNT, "rerun_guard"),
      tag(AUTH_EXEC, "rerun_auth_exec"),
      DOWN_RAW,
      tag(GUARD_COUNT, "down_guard"),
      tag(AUTH_EXEC, "down_auth_exec"),
      UP_RAW,
      UP_RAW,
      tag(GUARD_COUNT, "upup_guard"),
      tag(AUTH_EXEC, "upup_auth_exec"),
      // Service-role path (owner, no JWT): sync still applies.
      tag(syncOp("create", "null", 2), "service_sync"),
      // Authenticated path: A syncs A's own row through apply_sync_op...
      "set local role authenticated;",
      claims(a.id),
      tag(syncOp("update", "1", 4), "auth_sync"),
      // ...but cannot reach the internal directly, even for itself.
      "do $t$ begin",
      `  perform _sync_current('${a.id}', 'water_log', '${date}');`,
      "  raise exception 'internal_reachable';",
      "exception when insufficient_privilege then null;",
      "end $t$;",
      "reset role;",
      // Guard: as owner with A's claims, B's id is refused.
      claims(a.id),
      "do $t$ begin",
      `  perform _sync_upsert('${b.id}', 'water_log', '${date}', '{"cups":9}'::jsonb, 1);`,
      "  raise exception 'guard_missing';",
      "exception when insufficient_privilege then null;",
      "end $t$;",
      "select 'scenario_done:true';",
      "rollback;",
    ].join("\n"));
    const lines = out.split("\n");
    expect(lines).toContain(`rerun_guard:${ONE_EACH}`);
    expect(lines).toContain("rerun_auth_exec:false");
    expect(lines).toContain("down_guard:_sync_current=0,_sync_tombstone=0,_sync_upsert=0");
    expect(lines).toContain("down_auth_exec:false");
    expect(lines).toContain(`upup_guard:${ONE_EACH}`);
    expect(lines).toContain("upup_auth_exec:false");
    expect(lines).toContain("service_sync:applied");
    expect(lines).toContain("auth_sync:applied");
    expect(lines).toContain("scenario_done:true");
  });
});

async function syncCreate(owner: string, entity: string, key: string, payload: object) {
  const { data, error } = await adminClient().rpc("apply_sync_op", { p_user_id: owner, p_op: {
    op_id: crypto.randomUUID(), entity, entity_id: key, kind: "create", base_rev: null,
    payload, client_ts: new Date().toISOString() } });
  if (error) throw new Error(`seed ${entity}: ${error.message}`);
  return data as { status: string; rev: number };
}

async function row(table: string, match: Record<string, unknown>) {
  const { data, error } = await adminClient().from(table).select("*").match(match).maybeSingle();
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

const day = () => `2042-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${
  String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;

describe.skipIf(!HAS_BRANCH)("sync internals over PostgREST, A with B's ids", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    asA = await userClient(a);
  });

  it("_sync_current will not return B's row", async () => {
    const date = day();
    await syncCreate(b.id, "water_log", date, { cups: 3 });
    const { data, error } = await asA.rpc("_sync_current",
      { p_user_id: b.id, p_entity: "water_log", p_key: date });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("_sync_upsert will not change B's row", async () => {
    const date = day();
    await syncCreate(b.id, "water_log", date, { cups: 3 });
    const { error } = await asA.rpc("_sync_upsert", { p_user_id: b.id, p_entity: "water_log",
      p_key: date, p_payload: { cups: 77 }, p_rev: 2 });
    expect(error).not.toBeNull();
    expect((await row("water_log", { user_id: b.id, local_date: date }))?.cups).toBe(3);
  });

  it("_sync_tombstone will not delete B's row", async () => {
    const foodId = crypto.randomUUID();
    await syncCreate(b.id, "user_foods", foodId, { name: "Tenancy probe", kind: "custom" });
    const { error } = await asA.rpc("_sync_tombstone", { p_user_id: b.id, p_entity: "user_foods",
      p_key: foodId, p_kind: "delete", p_rev: 2 });
    expect(error).not.toBeNull();
    expect((await row("user_foods", { id: foodId }))?.deleted_at).toBeNull();
  });

  it("A cannot call them for A either — only apply_sync_op is the public door", async () => {
    const { error } = await asA.rpc("_sync_current",
      { p_user_id: a.id, p_entity: "water_log", p_key: day() });
    expect(error).not.toBeNull();
  });

  it("normal sync still works for A: create, update, delete through apply_sync_op", async () => {
    const date = day();
    const op = (kind: string, baseRev: number | null, payload: object) =>
      asA.rpc("apply_sync_op", { p_user_id: a.id, p_op: { op_id: crypto.randomUUID(),
        entity: "water_log", entity_id: date, kind, base_rev: baseRev, payload,
        client_ts: new Date().toISOString() } });
    const created = await op("create", null, { cups: 2 });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ status: "applied", rev: 1 });
    const updated = await op("update", 1, { cups: 5 });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ status: "applied", rev: 2 });
    expect((await row("water_log", { user_id: a.id, local_date: date }))?.cups).toBe(5);

    const foodId = crypto.randomUUID();
    const food = (kind: string, baseRev: number | null, payload: object) =>
      asA.rpc("apply_sync_op", { p_user_id: a.id, p_op: { op_id: crypto.randomUUID(),
        entity: "user_foods", entity_id: foodId, kind, base_rev: baseRev, payload,
        client_ts: new Date().toISOString() } });
    expect((await food("create", null, { name: "Mine", kind: "custom" })).data)
      .toMatchObject({ status: "applied" });
    const deleted = await food("delete", 1, {});
    expect(deleted.error).toBeNull();
    expect(deleted.data).toMatchObject({ status: "applied" });
    expect((await row("user_foods", { id: foodId }))?.deleted_at).not.toBeNull();
  });
});
