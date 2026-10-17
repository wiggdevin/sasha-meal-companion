import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { loadStore, saveStore } from "@/lib/store";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import { canHideFood, hideFood, unhideFood } from "./hide-client";
import type { Food } from "@/lib/foods";

const ID = "22222222-2222-4222-8222-222222222222";
const food: Food = { id: ID, name: "Rice", role: "carb", unit: "g", perUnit: { protein: 0, carbs: 1, fat: 0 },
  status: "neutral", note: "hurt on 9/12", updatedAt: "2026-10-01T00:00:00.000Z" };

describe("hiding a neutral food (W148)", () => {
  beforeEach(async () => {
    await resetTestAccount();
    globalThis.indexedDB = new IDBFactory();
    const store = loadStore();
    saveStore({ ...store, foods: { [ID]: food } });
  });

  it("does nothing for a food with no synced row", async () => {
    expect(await canHideFood(food)).toBe(false);
    expect(await hideFood(food)).toBe(false);
    expect(loadStore().foods[ID]).toBeTruthy();
  });

  it("queues a delete and removes the row, then Undo queues a restore and brings it back", async () => {
    const { accountHandle } = await import("@/lib/device/account");
    const h = accountHandle();
    await putRow(h, "user_foods", ID, { id: ID, name: "Rice", rev: 3, deleted_at: null });
    expect(await canHideFood(food)).toBe(true);
    expect(await hideFood(food)).toBe(true);
    expect(loadStore().foods[ID]).toBeUndefined();
    expect(await getRow(h, "user_foods", ID)).toMatchObject({ rev: 4 });
    expect((await getRow(h, "user_foods", ID))?.deleted_at).toBeTruthy();

    expect(await unhideFood(food)).toBe(true);
    expect(loadStore().foods[ID]).toMatchObject({ name: "Rice", note: "hurt on 9/12", status: "neutral" });
    const ops = await allOps(h);
    expect(ops.map((op) => [op.entity, op.kind, op.base_rev])).toEqual([
      ["user_foods", "delete", 3], ["user_foods", "restore", 4]]);
  });
});
