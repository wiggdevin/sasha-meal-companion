import { beforeEach, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, adminClient, ensureUser, resetUser, userClient, type TestUser,
} from "../helpers/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

type Kind = "create" | "update" | "delete" | "restore";
type Result = Record<string, unknown> & { status: string };

const FOOD = "33333333-3333-4333-8333-333333333333";
const GUT = "44444444-4444-4444-8444-444444444444";
const ENTRY = "55555555-5555-4555-8555-555555555555";
const GROUP = "66666666-6666-4666-8666-666666666666";
const REF = "77777777-7777-4777-8777-777777777777";

describe.skipIf(!HAS_BRANCH)("apply_sync_op", () => {
  let a: TestUser;
  let client: SupabaseClient;

  async function op(
    entity: string, entityId: string, kind: Kind,
    baseRev: number | null, payload: Record<string, unknown> = {},
    opId: string = crypto.randomUUID(),
  ): Promise<Result> {
    const { data, error } = await client.rpc("apply_sync_op", {
      p_user_id: a.id,
      p_op: { op_id: opId, entity, entity_id: entityId, kind, base_rev: baseRev,
              payload, client_ts: new Date().toISOString() },
    });
    if (error) throw error;
    return data as Result;
  }

  beforeEach(async () => {
    a = await ensureUser("a");
    await resetUser(a.id);
    client = await userClient(a);
  });

  it("create applies at rev 1 and seq 1", async () => {
    const r = await op("user_foods", FOOD, "create", null, { name: "Chicken", kind: "custom" });
    expect(r).toMatchObject({ status: "applied", rev: 1, seq: 1 });
  });

  it("a repeated op_id is a duplicate and does not re-apply", async () => {
    const opId = crypto.randomUUID();
    await op("water_log", "2026-09-11", "create", null, { cups: 2 }, opId);
    const again = await op("water_log", "2026-09-11", "update", 1, { cups: 9 }, opId);
    expect(again).toEqual({ op_id: opId, status: "duplicate" });
    const row = await adminClient().from("water_log")
      .select("cups, rev").eq("user_id", a.id).eq("local_date", "2026-09-11").single();
    expect(row.data).toMatchObject({ cups: 2, rev: 1 });
  });

  it("a stale update conflicts and returns the full current entity", async () => {
    await op("user_foods", FOOD, "create", null, { name: "Chicken", kind: "custom" });
    await op("user_foods", FOOD, "update", 1, { name: "Chicken thigh", kind: "custom" });
    const stale = await op("user_foods", FOOD, "update", 1, { name: "Nope", kind: "custom" });
    expect(stale).toMatchObject({ status: "conflict", entity: "user_foods", current_rev: 2 });
    expect((stale.current as { name: string }).name).toBe("Chicken thigh");
    const row = await adminClient().from("user_foods").select("name").eq("id", FOOD).single();
    expect(row.data?.name).toBe("Chicken thigh");
  });

  it("a create on an existing row is a conflict, not a second row", async () => {
    await op("gut_log", GUT, "create", null,
      { local_date: "2026-09-11", tz: "America/New_York", state: "good" });
    const second = await op("gut_log", GUT, "create", null,
      { local_date: "2026-09-11", tz: "America/New_York", state: "flare" });
    expect(second).toMatchObject({ status: "conflict", current_rev: 1 });
  });

  it("an update on an unknown key is gone", async () => {
    const r = await op("user_foods", FOOD, "update", 1, { name: "Ghost", kind: "custom" });
    expect(r).toMatchObject({ status: "gone" });
  });

  it("a stale update on a tombstone returns deleted and never resurrects it", async () => {
    await op("log_entries", ENTRY, "create", null, {
      eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
      slot: "meal-1", method: "plan", items: [],
    });
    const gone = await op("log_entries", ENTRY, "delete", 1);
    expect(gone).toMatchObject({ status: "applied", rev: 2 });
    const stale = await op("log_entries", ENTRY, "update", 1, {
      eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
      slot: "meal-2", method: "plan", items: [],
    });
    expect(stale.status).toBe("deleted");
    expect(stale.deleted_at).toBeTruthy();
    const row = await adminClient().from("log_entries").select("slot, deleted_at")
      .eq("id", ENTRY).single();
    expect(row.data?.slot).toBe("meal-1");
    expect(row.data?.deleted_at).not.toBeNull();
  });

  it("restore clears the tombstone and bumps rev", async () => {
    await op("gut_log", GUT, "create", null,
      { local_date: "2026-09-11", tz: "America/New_York", state: "good" });
    await op("gut_log", GUT, "delete", 1);
    const back = await op("gut_log", GUT, "restore", 2);
    expect(back).toMatchObject({ status: "applied", rev: 3 });
    const row = await adminClient().from("gut_log").select("deleted_at").eq("id", GUT).single();
    expect(row.data?.deleted_at).toBeNull();
  });

  it("delete on a non-tombstone entity is 'unsupported' and writes nothing", async () => {
    await op("water_log", "2026-09-11", "create", null, { cups: 2 });
    const result = await op("water_log", "2026-09-11", "delete", 1);
    expect(result).toEqual({ op_id: result.op_id, status: "unsupported" });
    const row = await adminClient().from("water_log")
      .select("cups, rev").eq("user_id", a.id).eq("local_date", "2026-09-11").single();
    expect(row.data).toMatchObject({ cups: 2, rev: 1 }); // untouched — no hard delete, no raise
  });

  it("restore on a non-tombstone entity is also 'unsupported'", async () => {
    await op("plan_days", "2026-09-11", "create", null, { floor_day: false });
    const result = await op("plan_days", "2026-09-11", "restore", 1);
    expect(result.status).toBe("unsupported");
  });

  it("restore on a row that was never tombstoned is an idempotent no-op", async () => {
    await op("gut_log", GUT, "create", null,
      { local_date: "2026-09-11", tz: "America/New_York", state: "good" });
    const before = await adminClient().from("change_log")
      .select("*", { count: "exact", head: true }).eq("user_id", a.id);
    const result = await op("gut_log", GUT, "restore", 1);
    expect(result).toMatchObject({ status: "applied", rev: 1 }); // rev unchanged, not bumped
    const after = await adminClient().from("change_log")
      .select("*", { count: "exact", head: true }).eq("user_id", a.id);
    expect(after.count).toBe(before.count); // no new change_log row for the no-op
    const row = await adminClient().from("gut_log").select("deleted_at").eq("id", GUT).single();
    expect(row.data?.deleted_at).toBeNull();
  });

  it("seq is contiguous and ascending across entities", async () => {
    await op("user_foods", FOOD, "create", null, { name: "Chicken", kind: "custom" });
    await op("water_log", "2026-09-11", "create", null, { cups: 1 });
    await op("plan_days", "2026-09-11", "create", null, { floor_day: true });
    await op("water_log", "2026-09-11", "update", 1, { cups: 2 });
    const { data, error } = await client.rpc("sync_changes", {
      p_user_id: a.id, p_since: 0, p_limit: 500,
    });
    expect(error).toBeNull();
    const rows = data as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("sync_changes pages from a cursor", async () => {
    await op("water_log", "2026-09-11", "create", null, { cups: 1 });
    await op("water_log", "2026-09-12", "create", null, { cups: 1 });
    const { data } = await client.rpc("sync_changes", { p_user_id: a.id, p_since: 1, p_limit: 500 });
    expect((data as { seq: number }[]).map((r) => r.seq)).toEqual([2]);
  });

  it("log_items are replaced wholesale and returned inline", async () => {
    const admin = adminClient();
    const food = await admin.from("user_foods")
      .insert({ id: FOOD, user_id: a.id, name: "Rice", kind: "custom" }).select("id").single();
    expect(food.error).toBeNull();
    const ref = await admin.from("food_refs")
      .insert({ id: REF, kind: "user", user_food_id: FOOD }).select("id").single();
    expect(ref.error).toBeNull();
    await op("log_entries", ENTRY, "create", null, {
      eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
      slot: "meal-1", method: "text",
      items: [
        { seq: 1, qty: 1, unit: "cup", food_ref_id: REF, grams: 150, snapshot: {} },
        { seq: 2, qty: 2, unit: "cup", food_ref_id: REF, grams: 300, snapshot: {} },
      ],
    });
    await op("log_entries", ENTRY, "update", 1, {
      eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York", local_date: "2026-09-11",
      slot: "meal-1", method: "text",
      items: [{ seq: 1, qty: 3, unit: "cup", food_ref_id: REF, grams: 450, snapshot: {} }],
    });
    const feed = await admin.from("change_log")
      .select("current").eq("user_id", a.id).order("seq", { ascending: false }).limit(1).single();
    const items = (feed.data?.current as { items: { grams: number }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0].grams).toBe(450);
  });

  it.each([
    ["user_foods", FOOD, { name: "X", kind: "custom" }],
    ["log_entries", ENTRY, { eaten_at: "2026-09-11T12:00:00Z", tz: "America/New_York",
      local_date: "2026-09-11", slot: "meal-1", method: "plan", items: [] }],
    ["gut_log", GUT, { local_date: "2026-09-11", tz: "America/New_York", state: "good" }],
    ["duplicate_groups", GROUP, { local_date: "2026-09-11", slot: "meal-1",
      fingerprint: "deadbeef", state: "open" }],
    ["water_log", "2026-09-11", { cups: 1 }],
    ["plan_days", "2026-09-11", { floor_day: false }],
    ["user_settings", "settings", { first_opened_at: "2026-09-11T12:00:00Z" }],
  ] as const)("entity_key %s round-trips into change_log", async (entity, key, payload) => {
    const r = await op(entity, key, "create", null, payload as Record<string, unknown>);
    expect(r.status).toBe("applied");
    const feed = await adminClient().from("change_log")
      .select("entity, entity_key").eq("user_id", a.id).order("seq", { ascending: false })
      .limit(1).single();
    expect(feed.data).toEqual({ entity, entity_key: key });
  });

  it("user_food_prefs keys on the food_ref_id uuid", async () => {
    const admin = adminClient();
    await admin.from("user_foods").insert({ id: FOOD, user_id: a.id, name: "Rice", kind: "custom" });
    await admin.from("food_refs").insert({ id: REF, kind: "user", user_food_id: FOOD });
    const r = await op("user_food_prefs", REF, "create", null, { status: "eats", role: "carb" });
    expect(r.status).toBe("applied");
    const row = await admin.from("user_food_prefs")
      .select("status").eq("user_id", a.id).eq("food_ref_id", REF).single();
    expect(row.data?.status).toBe("eats");
  });

  it("two devices creating duplicate_groups for the same fingerprint converge on one row", async () => {
    const GROUP_B = "77777777-7777-4777-8888-777777777777";
    const payload = { local_date: "2026-09-11", slot: "meal-1", fingerprint: "deadbeef", state: "open" };
    const first = await op("duplicate_groups", GROUP, "create", null, payload);
    expect(first.status).toBe("applied");
    // A second device independently detects the same real-world duplicate and mints its own
    // random id for the create op — same fingerprint, different entity_id. This must not raise
    // a raw unique-constraint violation out of the RPC; the two devices should converge on one
    // duplicate_groups row instead of racing.
    const second = await op("duplicate_groups", GROUP_B, "create", null, payload);
    expect(second.status).toBe("applied");
    const rows = await adminClient().from("duplicate_groups")
      .select("id").eq("user_id", a.id).eq("slot", "meal-1");
    expect(rows.data).toHaveLength(1);
  });

  it("a malformed entity_key is rejected", async () => {
    const { error } = await client.rpc("apply_sync_op", {
      p_user_id: a.id,
      p_op: { op_id: crypto.randomUUID(), entity: "water_log", entity_id: "11 September",
              kind: "create", base_rev: null, payload: {}, client_ts: new Date().toISOString() },
    });
    expect(error?.message).toContain("bad_entity_key");
  });
});
