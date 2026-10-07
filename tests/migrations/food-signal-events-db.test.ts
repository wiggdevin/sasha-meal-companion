/**
 * Phase 18 W6, migration 20261219090000 `food_signal_events` (docs/specs/phase-18-open-world-foods.md
 * §W6). The text half runs in every unit shard; the database half runs on the migrated local stack
 * (SUPABASE_TEST_DB_URL and the TEST API settings). Nothing here can reach production
 * (tests/tenancy/local-only).
 *
 * Acceptance: 1. RLS denies another user's select and insert. 2. Each event stores its offered
 * slate; an event for a food that was not offered is rejected (constraint and RPC). 3. "Not this"
 * and a taste dislike are stored apart. 4. The purge removes rows older than 180 days.
 * Plus: a retried client event id inserts once.
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, userClient, type TestUser,
} from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read("supabase/migrations/20261219090000_food_signal_events.sql");
const DOWN = read("supabase/migrations/down/20261219090000_food_signal_events.down.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const today = () => new Date().toISOString().slice(0, 10);
function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_event_id: crypto.randomUUID(), slate_id: crypto.randomUUID(), at: new Date().toISOString(),
    local_date: today(), surface: "swap_sheet", kind: "picked", occasion: "dinner",
    chosen_key: "food:salmon", offered_keys: ["food:salmon", "catalog:1234", "food:tofu"],
    ranking_version: "o2.1", ...over,
  };
}

describe("20261219090000 food_signal_events (text)", () => {
  it("is live-safe and reversible", () => {
    for (const file of [UP, DOWN]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    expect(code(DOWN)).toContain("drop table if exists public.food_signal_events;");
  });

  it("refuses an unoffered food in the table itself, not only in the route", () => {
    expect(code(UP)).toContain("constraint food_signal_events_offered check (chosen_key = any (offered_keys))");
    expect(code(UP)).toMatch(/cardinality\(p_keys\) between 1 and 8/);
  });

  it("keeps \"Not this\" apart from a taste dislike: no dislike kind, no write to user_settings", () => {
    expect(code(UP)).toContain("kind in ('picked', 'swapped_away', 'not_this', 'added')");
    expect(code(UP)).not.toMatch(/dislike/i);
    expect(code(UP)).not.toMatch(/user_settings|diet_prefs/);
  });

  it("is owner-only: the batch RPC is security invoker, the purge is service_role only", () => {
    expect(code(UP)).toMatch(/record_food_signals\(p_events jsonb\)[\s\S]*?security invoker/);
    expect(code(UP)).toContain("revoke all on function public.food_signal_events_purge(integer) from public, anon, authenticated;");
    expect(code(UP)).toContain("grant select on table public.food_signal_events to authenticated, service_role;");
    expect(code(UP)).not.toMatch(/grant [^;]*(update|delete)[^;]* to authenticated/);
    // No API role writes created_at: the column-level insert grant leaves it out.
    const insertGrant = /grant insert \(([^)]*)\)/.exec(code(UP))?.[1] ?? "";
    expect(insertGrant).toContain("offered_keys");
    expect(insertGrant).not.toContain("created_at");
  });
});

describe.skipIf(!HAS_DB || !HAS_BRANCH)("20261219090000 food_signal_events (database)", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let asB: SupabaseClient;

  const rowsOf = async (owner: string) => {
    const { data, error } = await adminClient().from("food_signal_events").select("*").eq("user_id", owner);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  const clear = () => runSql(`delete from public.food_signal_events where user_id in ('${a.id}', '${b.id}')`);

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
    clear();
  });
  afterAll(() => clear());

  it("stores each event with its offered slate, under the caller", async () => {
    const sent = event({ kind: "swapped_away", chosen_key: "food:tofu" });
    const { data, error } = await asA.rpc("record_food_signals", { p_events: [sent] });
    expect(error).toBeNull();
    expect(data).toEqual([{ inserted: 1, duplicates: 0, rejected: 0 }]);
    const row = (await rowsOf(a.id)).find((r) => r.client_event_id === sent.client_event_id);
    expect(row).toMatchObject({ user_id: a.id, kind: "swapped_away", chosen_key: "food:tofu",
      offered_keys: sent.offered_keys, slate_id: sent.slate_id, occasion: "dinner" });
  });

  it("rejects an event for a food that was not offered: the RPC skips it, the table refuses it", async () => {
    const offered = event();
    const unoffered = event({ kind: "not_this", chosen_key: "food:liver" });
    const { data, error } = await asA.rpc("record_food_signals", { p_events: [unoffered, offered] });
    expect(error).toBeNull();
    expect(data).toEqual([{ inserted: 1, duplicates: 0, rejected: 1 }]);
    const direct = await asA.from("food_signal_events").insert({ ...event({ chosen_key: "food:liver" }), user_id: a.id });
    expect(direct.error?.code).toBe("23514");
    const asService = await adminClient().from("food_signal_events").insert({ ...event({ chosen_key: "food:liver" }), user_id: a.id });
    expect(asService.error?.code).toBe("23514");
    expect((await rowsOf(a.id)).filter((r) => r.chosen_key === "food:liver")).toEqual([]);
  });

  it("refuses a slate over 8 keys, a repeated key or a malformed key", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `catalog:${i + 1}`);
    for (const offered_keys of [nine, ["food:salmon", "food:salmon"], ["food:salmon", "Salmon fillet"]]) {
      const { error } = await asA.from("food_signal_events").insert({ ...event({ offered_keys }), user_id: a.id });
      expect(error?.code).toBe("23514");
    }
  });

  it("a retried client event id inserts once", async () => {
    const sent = event();
    await asA.rpc("record_food_signals", { p_events: [sent] });
    const again = await asA.rpc("record_food_signals", { p_events: [sent, sent] });
    expect(again.data).toEqual([{ inserted: 0, duplicates: 2, rejected: 0 }]);
    expect((await rowsOf(a.id)).filter((r) => r.client_event_id === sent.client_event_id)).toHaveLength(1);
  });

  it("RLS denies another user's select and insert", async () => {
    const sent = event();
    await asA.rpc("record_food_signals", { p_events: [sent] });
    const seen = await asB.from("food_signal_events").select("id").eq("client_event_id", sent.client_event_id as string);
    expect(seen.data).toEqual([]);
    const forged = await asB.from("food_signal_events").insert({ ...event(), user_id: a.id });
    expect(forged.error?.code).toBe("42501");
    const before = await rowsOf(a.id);
    // B's batch can only ever land under B.
    await asB.rpc("record_food_signals", { p_events: [{ ...event(), user_id: a.id }] });
    expect(await rowsOf(a.id)).toEqual(before);
    const update = await asA.from("food_signal_events").update({ kind: "picked" }).eq("client_event_id", sent.client_event_id as string).select("id");
    expect(update.data ?? []).toEqual([]);
  });

  it("stores \"Not this\" as an event and leaves the taste dislikes alone; there is no dislike kind", async () => {
    runSql(`insert into public.user_settings (user_id, first_opened_at, diet_prefs)
      values ('${a.id}', now(), '{"taste":{"dislikes":["f:okra"]}}')
      on conflict (user_id) do update set diet_prefs = excluded.diet_prefs`);
    const prefs = () => runSql(`select coalesce(diet_prefs::text, 'null') from public.user_settings where user_id = '${a.id}'`);
    const before = prefs();
    const { data } = await asA.rpc("record_food_signals", { p_events: [event({ kind: "not_this", surface: "plan_sheet" })] });
    expect(data).toEqual([{ inserted: 1, duplicates: 0, rejected: 0 }]);
    expect(prefs()).toBe(before);
    expect(before).toContain('"dislikes": ["f:okra"]');
    const dislike = await asA.from("food_signal_events").insert({ ...event({ kind: "dislike" }), user_id: a.id });
    expect(dislike.error?.code).toBe("23514");
  });

  it("skips a malformed event and keeps the rest of its batch", async () => {
    const good = event();
    const bad = [event({ kind: "dislike" }), event({ surface: "coach" }), event({ occasion: "brunch" }),
      event({ offered_keys: ["food:salmon", "food:salmon"] }), event({ chosen_key: "catalog:0", offered_keys: ["catalog:0"] }),
      event({ ranking_version: "Bad Version" }), event({ offered_keys: null }), event({ slate_id: null })];
    const { data, error } = await asA.rpc("record_food_signals", { p_events: [...bad, good] });
    expect(error).toBeNull();
    expect(data).toEqual([{ inserted: 1, duplicates: 0, rejected: bad.length }]);
  });

  it("no API role can back-date created_at to keep a far-future event past the purge", async () => {
    const future = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const row = { ...event({ at: future, local_date: future.slice(0, 10) }), user_id: a.id };
    for (const client of [asA, adminClient()]) {
      const { error } = await client.from("food_signal_events").insert({ ...row, created_at: future });
      expect(error?.code).toBe("42501");
    }
    expect((await asA.from("food_signal_events").insert(row)).error?.code).toBe("23514");
  });

  it("refuses an empty batch or one over 20 events", async () => {
    for (const p_events of [[], Array.from({ length: 21 }, () => event())]) {
      const { error } = await asA.rpc("record_food_signals", { p_events });
      expect(error?.code).toBe("22023");
    }
  });

  it("the purge removes rows older than 180 days and keeps younger ones; no client may run it", async () => {
    const old = crypto.randomUUID();
    const young = crypto.randomUUID();
    for (const [id, days] of [[old, 181], [young, 179]] as const) {
      runSql(`insert into public.food_signal_events (user_id, client_event_id, slate_id, at, local_date,
        surface, kind, occasion, chosen_key, offered_keys, ranking_version, created_at)
        values ('${b.id}', '${id}', gen_random_uuid(), now() - interval '${days} days',
        (now() - interval '${days} days')::date, 'swap_sheet', 'picked', 'lunch', 'food:rice',
        '{food:rice}', 'o2.1', now() - interval '${days} days')`);
    }
    const denied = await asA.rpc("food_signal_events_purge", { p_max: 100 });
    expect(denied.error).not.toBeNull();
    const { data, error } = await adminClient().rpc("food_signal_events_purge", { p_max: 5000 });
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
    const left = (await rowsOf(b.id)).map((r) => r.client_event_id);
    expect(left).toContain(young);
    expect(left).not.toContain(old);
  });

  it("the down file reverses it and the up file re-applies (inside a rolled-back transaction)", () => {
    const out = runSql(`begin; ${DOWN}
      select to_regclass('public.food_signal_events') is null; ${UP}
      select to_regclass('public.food_signal_events') is not null; rollback;`);
    expect(out.split("\n").filter((line) => line === "t" || line === "f")).toEqual(["t", "t"]);
  });
});
