import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import { FoodPartialSaveError, saveFoodEdits, saveFoodNoteForRef } from "@/lib/foods/prefs-client";
import { allOps, getRow } from "@/lib/sync/idb";
import { resetTestAccount, TEST_USER } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const FOOD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let h: AccountHandle;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } } as Storage;
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
});

function fakeServer(opts: { rejectNutrition?: boolean; rejectRole?: boolean; offlineMembership?: boolean;
  offlineNote?: boolean } = {}) {
  const food = { id: FOOD_ID, user_id: TEST_USER, name: "My rice", brand: null,
    ingredients_text: null, catalog_food_id: null, kind: "custom", per_100g: {
      protein: 100, carbohydrate: 200, fat_total: 300 }, allergen_tags: [], note: "Old", rev: 1 };
  const pref = { food_ref_id: REF_ID, user_id: TEST_USER, status: "avoid", role: "carb",
    no_cook: false, note: "Old", rev: 3 };
  const changes: { entity: string; payload: Record<string, unknown> }[] = [];
  const membershipCalls: { status: string | null; note: string | null }[] = [];
  let authoritativeNote: string | null | undefined;
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
        in: () => chain, is: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: table === "user_foods"
          ? filters.name === food.name || filters.id === food.id ? { ...food } : null
          : filters.food_ref_id === pref.food_ref_id ? { ...pref } : null, error: null }),
        single: async () => ({ data: table === "user_foods" && filters.id === food.id
          ? { ...food } : null, error: null }),
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "get_or_create_food_ref") return { data: REF_ID, error: null };
      if (name === "save_food_note") {
        if (opts.offlineNote) throw new Error("network unavailable");
        const note = args.p_note as string | null;
        const byPref = args.p_food_id === null && args.p_food_ref_id === REF_ID;
        const byFood = args.p_food_id === food.id && args.p_food_ref_id === null;
        const current = byPref ? pref : food;
        if ((!byPref && !byFood)
          || (args.p_base_rev !== current.rev || args.p_expected_note !== current.note)
            && current.note !== (note ?? "")) return {
          data: null, error: { code: "40001", message: "note_conflict" } };
        authoritativeNote = note;
        food.note = note ?? "";
        pref.note = note ?? "";
        food.rev += 1;
        pref.rev += 1;
        changes.push({ entity: "user_foods", payload: { ...food } });
        changes.push({ entity: "user_food_prefs", payload: { ...pref } });
        return { data: { food_rows: 1, pref_rows: 1 }, error: null };
      }
      if (name === "set_food_membership") {
        const status = args.p_status as string | null;
        const note = args.p_note as string | null;
        membershipCalls.push({ status, note });
        if (opts.offlineMembership) throw new Error("network unavailable");
        pref.status = status ?? "avoid";
        pref.note = authoritativeNote === undefined ? note ?? pref.note : authoritativeNote ?? "";
        pref.rev += 1;
        return { data: { rev: args.p_rev, status, updated: 1, truncated: false }, error: null };
      }
      if (name === "apply_sync_op") {
        const op = args.p_op as { entity: string; base_rev: number;
          payload: Record<string, unknown> };
        if ((op.entity === "user_foods" && opts.rejectNutrition)
          || (op.entity === "user_food_prefs" && opts.rejectRole)) return {
          data: { status: "conflict", current_rev: op.entity === "user_foods" ? food.rev : pref.rev },
          error: null };
        const row = op.entity === "user_foods" ? food : pref;
        if (op.base_rev !== row.rev) return { data: { status: "conflict", current_rev: row.rev }, error: null };
        Object.assign(row, op.payload);
        row.rev += 1;
        changes.push({ entity: op.entity, payload: op.payload });
        return { data: { status: "applied", rev: row.rev, seq: changes.length }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  return { client: client as never, rawRpc: client.rpc, food, pref, changes, membershipCalls };
}

function localFood(over: Partial<Food> = {}): Food {
  return { id: "my-rice", name: "My rice", role: "carb", unit: "g",
    perUnit: { protein: 1, carbs: 2, fat: 3 }, status: "eats", note: "Old",
    updatedAt: "2026-09-27T00:00:00.000Z", ...over };
}

it("syncs complete role and nutrition rows without replaying a stale Eats status", async () => {
  const server = fakeServer();
  const result = await saveFoodEdits(localFood(), "Old", "protein",
    { protein: 2, carbs: 4, fat: 6 }, { supabase: server.client });
  expect(result.syncing).toBe(false);
  expect(server.membershipCalls).toEqual([]);
  expect(server.changes.map((change) => change.entity)).toEqual(["user_food_prefs", "user_foods"]);
  // Audit 2026-10-10 P15 (W029): the role save is a field delta; it carries no status to revert.
  expect(server.changes[0].payload).toEqual({ role: "protein" });
  expect(server.pref).toMatchObject({ status: "avoid", role: "protein", rev: 4 });
  expect(server.food).toMatchObject({ rev: 2, per_100g: {
    protein: 200, carbohydrate: 400, fat_total: 600 } });
  expect(await getRow(h, "user_food_prefs", REF_ID)).toMatchObject({ status: "avoid", role: "protein", rev: 4 });
  expect(await getRow(h, "user_foods", FOOD_ID)).toMatchObject({ rev: 2 });
  expect(await allOps(h)).toEqual([]);
});

it("saves a note from stale Eats without replaying membership and logs both sync rows", async () => {
  const server = fakeServer();
  const result = await saveFoodEdits(localFood(), "Still hurts", "carb", undefined,
    { supabase: server.client });
  expect(result.saved.note).toBe(true);
  expect(result.syncing).toBe(false);
  expect(server.membershipCalls).toEqual([]);
  expect(server.pref).toMatchObject({ status: "avoid", note: "Still hurts", rev: 4 });
  expect(server.food).toMatchObject({ note: "Still hurts", rev: 2 });
  expect(server.changes.map((change) => change.entity)).toEqual(["user_foods", "user_food_prefs"]);
  expect(await allOps(h)).toEqual([]);
});

it("clears a note explicitly without changing the Avoid membership", async () => {
  const server = fakeServer();
  await saveFoodEdits(localFood(), "", "carb", undefined, { supabase: server.client });
  expect(server.pref.status).toBe("avoid");
  expect(server.pref.note).toBe("");
  expect(server.food.note).toBe("");
  expect(server.membershipCalls).toEqual([]);
});

it("rejects a stale note form even when the row rev was fetched during Save", async () => {
  const server = fakeServer();
  server.food.note = "Newer note";
  server.food.rev += 1;
  await expect(saveFoodEdits(localFood(), "Stale device edit", "carb", undefined,
    { supabase: server.client })).rejects.toThrow("This note changed on another device");
  expect(server.food.note).toBe("Newer note");
  expect(server.membershipCalls).toEqual([]);
});

it("keeps an explicit clear after a legacy queued status replays its old note", async () => {
  const server = fakeServer();
  await saveFoodEdits(localFood(), "", "carb", undefined, { supabase: server.client });
  await server.rawRpc("set_food_membership", {
    p_user: TEST_USER, p_name_norm: "my rice", p_status: "eats", p_note: "Old", p_rev: 10,
  });
  expect(server.membershipCalls).toEqual([{ status: "eats", note: "Old" }]);
  expect(server.pref.note).toBe("");
  expect(server.food.note).toBe("");
  await saveFoodNoteForRef(REF_ID, "New from coach", h, server.client, "");
  expect(server.pref.note).toBe("New from coach");
  await server.rawRpc("set_food_membership", {
    p_user: TEST_USER, p_name_norm: "my rice", p_status: "avoid", p_note: "Old", p_rev: 11,
  });
  expect(server.pref.note).toBe("New from coach");
});

it("reports a partial save when nutrition conflicts after the role was logged", async () => {
  const server = fakeServer({ rejectNutrition: true });
  await expect(saveFoodEdits(localFood(), "Old", "protein",
    { protein: 2, carbs: 4, fat: 6 }, { supabase: server.client }))
    .rejects.toMatchObject({ name: FoodPartialSaveError.name,
      saved: { role: true, nutrition: false, note: false } });
  expect(server.pref.role).toBe("protein");
  expect(server.food.per_100g).toMatchObject({ protein: 100 });
  expect(server.changes.map((change) => change.entity)).toEqual(["user_food_prefs"]);
});

it("reports a saved note but no role when the role revision conflicts", async () => {
  const server = fakeServer({ rejectRole: true });
  await expect(saveFoodEdits(localFood(), "Fresh note", "protein", undefined,
    { supabase: server.client })).rejects.toMatchObject({ name: FoodPartialSaveError.name,
    saved: { note: true, role: false, nutrition: false } });
  expect(server.pref).toMatchObject({ status: "avoid", note: "Fresh note", role: "carb" });
  expect(server.membershipCalls).toEqual([]);
});

it("rejects an offline note edit so the form stays dirty", async () => {
  const server = fakeServer({ offlineNote: true });
  await expect(saveFoodEdits(localFood(), "Still hurts", "carb", undefined,
    { supabase: server.client })).rejects.toThrow("network unavailable");
  expect(await allOps(h)).toEqual([]);
});

it("treats an offline initial membership acknowledgement as queued, not failed", async () => {
  const server = fakeServer({ offlineMembership: true });
  const result = await saveFoodEdits(localFood(), "Old", "carb", undefined,
    { supabase: server.client, ensureMembership: true });
  expect(result.syncing).toBe(true);
  expect(server.membershipCalls).toEqual([{ status: "eats", note: null }]);
  expect((await allOps(h)).map((op) => op.entity)).toEqual(["food_membership"]);
});
