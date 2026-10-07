import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { allOps, putRow } from "@/lib/sync/idb";
import { listFavorites, setFavorite, toggleFavorite } from "@/lib/favorites-client";
import { resetTestAccount } from "@/tests/helpers/account";
import { bindAccount, type AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => { h = await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); });

describe("toggleFavorite", () => {
  it("stars a food with a create op keyed by food_ref_id", async () => {
    expect(await toggleFavorite("food", REF, undefined, { name: "Rice" })).toBe(true);
    const [op] = await allOps(h);
    expect(op).toMatchObject({ entity: "favorites_foods", entity_id: REF, kind: "create" });
    expect(op.payload).toEqual({ food_ref_id: REF, sort: 1 });
  });

  it("unstars with a delete op on the row's rev", async () => {
    await toggleFavorite("food", REF, undefined, { name: "Rice" });
    await putRow(h, "favorites_foods", REF, { food_ref_id: REF, sort: 1, rev: 1 });
    expect(await toggleFavorite("food", REF)).toBe(false);
    const ops = await allOps(h);
    expect(ops.at(-1)).toMatchObject({ kind: "delete", base_rev: 1 });
  });

  it("lists foods, recipes and meals in sort order with their names", async () => {
    await toggleFavorite("food", REF, 2, { name: "Rice" });
    await putRow(h, "recipes", "r1", { id: "r1", name: "Rice tray", rev: 1 });
    await putRow(h, "favorites_recipes", "r1", { recipe_id: "r1", sort: 1, rev: 1 });
    const rows = await listFavorites();
    expect(rows.map((r) => [r.kind, r.name])).toEqual([["recipe", "Rice tray"], ["food", "Rice"]]);
  });

  it("hides favorite pointers to deleted or missing account recipes", async () => {
    await putRow(h, "recipes", "r1", { id: "r1", name: "Deleted tray", rev: 2,
      deleted_at: "2026-09-27T00:00:00.000Z" });
    await putRow(h, "favorites_recipes", "r1", { recipe_id: "r1", sort: 1, rev: 1 });
    await putRow(h, "favorites_recipes", "missing", { recipe_id: "missing", sort: 2, rev: 1 });
    expect(await listFavorites()).toEqual([]);
  });
});

describe("setFavorite", () => {
  it("is idempotent: a repeat of the same state writes nothing and never flips it back", async () => {
    expect(await setFavorite("food", REF, true, { name: "Rice" })).toBe(true);
    expect(await setFavorite("food", REF, true, { name: "Rice" })).toBe(true);
    expect((await allOps(h)).map((op) => op.kind)).toEqual(["create"]);
    expect(await setFavorite("food", REF, false)).toBe(false);
    expect(await setFavorite("food", REF, false)).toBe(false);
    expect((await allOps(h)).map((op) => op.kind)).toEqual(["create", "delete"]);
    expect(await listFavorites()).toEqual([]);
  });

  it("refuses to write as an account that is no longer bound", async () => {
    const before = h;
    bindAccount("22222222-2222-4222-8222-222222222222");
    await expect(setFavorite("food", REF, true, undefined, before)).rejects.toThrow(/account changed/i);
  });
});
