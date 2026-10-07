/**
 * Adopting a bundled food (lib/foods/adopt-client.ts) and the reopen seed that reads it back
 * (lib/recipes/use-recipe-sheet.ts). Split out of recipe-sheet-offline.test.tsx, which keeps the
 * sheet's own transition cases. Same harness: fake-indexeddb, a stubbed Supabase client, and the
 * env-guarded branch case at the end.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFood } from "@/lib/food-db";
import { adoptBundledFood, adoptedSnapshot, bundledFoodUserId, per100gFromBundled,
  rememberAdopted, type AdoptedSnapshot } from "@/lib/foods/adopt-client";
import { draftFromWire, readAdoptedBundledFood, seededDraft }
  from "@/lib/recipes/use-recipe-sheet";
import { provisionalNutrients } from "@/lib/recipes-client";
import { allOps, getRow, META_STORE, openAccountDb } from "@/lib/sync/idb";
import { createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** `browserClient()` is what `readAdoptedBundledFood` reaches for; each case sets what it answers. */
const mocks = vi.hoisted(() => ({ browserClient: vi.fn<() => SupabaseClient>() }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: mocks.browserClient }));

const CHICKEN = "chicken-breast-roasted";

/** The raw adoption index, so a case can prove both racing writes survived. */
async function adoptedIndex(): Promise<Record<string, AdoptedSnapshot>> {
  const db = await openAccountDb(h);
  return ((await db.get(META_STORE, "adopted_foods")) as Record<string, AdoptedSnapshot>) ?? {};
}

/** The `user_foods` upsert and the `get_or_create_food_ref` RPC, stubbed the way the server answers. */
function stubClient(rev: number, foodRefId: string): SupabaseClient {
  const single = async () => ({ data: { rev }, error: null });
  return {
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ upsert: () => ({ select: () => ({ single }) }) }),
    rpc: async () => ({ data: foodRefId, error: null }),
  } as unknown as SupabaseClient;
}

/** A read-only client answering the two owner-scoped selects the cold-index seed makes. */
function readerClient(rows: { food_refs?: unknown; user_foods?: unknown }): SupabaseClient {
  const answer = (data: unknown) => ({
    select: () => ({ eq: () => ({ single: async () =>
      data === undefined ? { data: null, error: { message: "not found" } } : { data, error: null },
    }) }),
  });
  return {
    from: (table: "food_refs" | "user_foods") => answer(rows[table]),
  } as unknown as SupabaseClient;
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  mocks.browserClient.mockReset();
});
afterEach(async () => {
  h = await resetTestAccount();
});

describe("adoption writes", () => {
  it("queues an update at the rev the direct upsert returned", async () => {
    const adopted = await adoptBundledFood(CHICKEN, { client: stubClient(3, "ref-x") });
    expect(adopted).toEqual({
      foodRefId: "ref-x",
      per100g: per100gFromBundled(dbFood(CHICKEN)!),
    });

    const id = await bundledFoodUserId(CHICKEN, h.userId);
    const [op] = (await allOps(h)).filter((entry) => entry.entity === "user_foods");
    expect(op).toMatchObject({ kind: "update", base_rev: 3, entity_id: id });
    expect(op.payload).toMatchObject({ id, user_id: h.userId });
    expect(op.payload).toMatchObject({ kind: "custom", name: "Chicken breast, roasted" });
    expect(op.payload).not.toHaveProperty("rev");
    // The local mirror carries the server's rev, so the next edit starts from it.
    expect(await getRow(h, "user_foods", id)).toMatchObject({ rev: 3, kind: "custom" });
  });

  it("adopts under an id of this account's own, so a second account is not refused", async () => {
    // user_foods.id is one key across every account: the old global `bundled:<id>` let only the
    // first account adopt a food, and RLS refused everyone after it.
    const first = await bundledFoodUserId(CHICKEN, h.userId);
    const other = await bundledFoodUserId(CHICKEN, "22222222-2222-4222-8222-222222222222");
    expect(other).not.toBe(first);
    expect(first).not.toBe(await bundledFoodUserId(CHICKEN));
    await adoptBundledFood(CHICKEN, { client: stubClient(1, "ref-x") });
    h = await resetTestAccount("22222222-2222-4222-8222-222222222222");
    globalThis.indexedDB = new IDBFactory();
    await adoptBundledFood(CHICKEN, { client: stubClient(1, "ref-y") });
    const [op] = (await allOps(h)).filter((entry) => entry.entity === "user_foods");
    expect(op.entity_id).toBe(other);
    expect(op.payload).toMatchObject({ user_id: "22222222-2222-4222-8222-222222222222" });
  });

  it("keeps the legacy global id readable for rows adopted before the fix", async () => {
    expect(await bundledFoodUserId(CHICKEN)).toBe("82edd001-2a46-52cc-8559-9372c6f2afb1");
  });

  it("reports the adoption as failed when the mirror and op cannot be written", async () => {
    // No IndexedDB at all: the server row would land, but the normalized write cannot. That is
    // a failed adoption, surfaced as null, never a silent "landed" (audit round 3, P2).
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    const adopted = await adoptBundledFood(CHICKEN, { client: stubClient(1, "ref-x") });
    expect(adopted).toBeNull();
  });

  it("keeps both snapshots when two adoptions run at once", async () => {
    await Promise.all([
      rememberAdopted(h, "ref-a", { name: "Food A", per100g: { energy_kcal: 100 } }),
      rememberAdopted(h, "ref-b", { name: "Food B", per100g: { energy_kcal: 200 } }),
    ]);
    const index = await adoptedIndex();
    expect(index["ref-a"]).toMatchObject({ name: "Food A" });
    expect(index["ref-b"]).toMatchObject({ name: "Food B" });
    expect(await adoptedSnapshot("ref-a")).toMatchObject({ name: "Food A" });
    expect(await adoptedSnapshot("ref-b")).toMatchObject({ name: "Food B" });
  });
});

describe("the reopen seed", () => {
  it("hydrates an adopted ingredient from the server row when the local index is cold", async () => {
    const wire = draftFromWire({ seq: 1, food_ref_id: "ref-remote", qty: 1, unit: "g",
      grams: 100, state: "cooked", food_revision_id: null });
    expect(await adoptedSnapshot("ref-remote")).toBeUndefined();

    const read = vi.fn(async () => ({ name: "Chicken breast, roasted",
      per100g: per100gFromBundled(dbFood(CHICKEN)!) }));
    const seeded = await seededDraft(wire, read);

    expect(read).toHaveBeenCalledWith("ref-remote");
    expect(seeded).toMatchObject({ name: "Chicken breast, roasted" });
    expect((await provisionalNutrients([seeded], 1)).perServing.energy_kcal).toBe(165);
  });

  it("reads the server row through food_refs then user_foods", async () => {
    mocks.browserClient.mockReturnValue(readerClient({
      food_refs: { user_food_id: "uf-1" },
      user_foods: { name: "Chicken breast, roasted", per_100g: { energy_kcal: 165, protein: 31 } },
    }));
    expect(await readAdoptedBundledFood("ref-remote")).toEqual({
      name: "Chicken breast, roasted", per100g: { energy_kcal: 165, protein: 31 },
    });
  });

  it("answers undefined when the food ref is unknown, when the row is gone, or signed out", async () => {
    mocks.browserClient.mockReturnValue(readerClient({}));
    expect(await readAdoptedBundledFood("ref-missing")).toBeUndefined();

    mocks.browserClient.mockReturnValue(readerClient({ food_refs: { user_food_id: "uf-gone" } }));
    expect(await readAdoptedBundledFood("ref-gone")).toBeUndefined();

    mocks.browserClient.mockImplementation(() => { throw new Error("no browser client"); });
    expect(await readAdoptedBundledFood("ref-any")).toBeUndefined();
  });

  it("keeps the local index the fast path — a hit never reads the server", async () => {
    await rememberAdopted(h, "ref-local", { name: "Local food", per100g: { energy_kcal: 90 } });
    const wire = draftFromWire({ seq: 1, food_ref_id: "ref-local", qty: 1, unit: "g",
      grams: 100, state: "cooked", food_revision_id: null });
    const read = vi.fn(async () => undefined);

    const seeded = await seededDraft(wire, read);
    expect(seeded.name).toBe("Local food");
    expect(read).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_BRANCH)("adopting a bundled food on the test branch", () => {
  it("adopts it once, queues the op, saves a one-item recipe against its food ref", async () => {
    const { a, admin } = await createTestUsers();
    await resetUser(a.userId);
    // Phase 9 §0.5a: the row carries the bound account as its owner, so bind the branch user whose
    // session writes it (RLS refuses a row owned by the fixed test user).
    h = await resetTestAccount(a.userId);

    const adopted = await adoptBundledFood(CHICKEN, { client: a.client });
    expect(adopted?.per100g.energy_kcal).toBe(165);
    const foodRefId = adopted!.foodRefId;
    expect((await adoptBundledFood(CHICKEN, { client: a.client }))?.foodRefId).toBe(foodRefId);

    // The server row the direct upsert wrote, and the rev it landed at.
    const id = await bundledFoodUserId(CHICKEN, a.userId);
    const serverRow = await admin.from("user_foods").select("rev, name, per_100g").eq("id", id).single();
    expect(serverRow.error).toBeNull();
    expect(serverRow.data).toMatchObject({ name: "Chicken breast, roasted" });
    const serverRev = (serverRow.data as { rev: number }).rev;

    // The op-log copy: same deterministic id, an update aimed at that rev, so another device
    // replays the row and the server applies it directly instead of answering a conflict.
    const [op] = (await allOps(h)).filter((entry) => entry.entity === "user_foods");
    expect(op).toMatchObject({ entity: "user_foods", kind: "update", base_rev: serverRev });
    expect(op.entity_id).toBe(id);
    expect(op.payload).toMatchObject({ kind: "custom", name: "Chicken breast, roasted" });
    expect(op.payload).not.toHaveProperty("rev");
    expect(await getRow(h, "user_foods", op.entity_id)).toMatchObject({ kind: "custom" });

    const recipeId = crypto.randomUUID();
    const { data, error } = await a.client.rpc("apply_sync_op", {
      p_user_id: a.userId,
      p_op: {
        op_id: crypto.randomUUID(), entity: "recipes", entity_id: recipeId, kind: "create",
        base_rev: null, client_ts: new Date().toISOString(),
        payload: { id: recipeId, name: "Chicken tray", servings: 1, yield_grams: null,
          items: [{ seq: 1, food_ref_id: foodRefId, qty: 1, unit: "g", grams: 100, state: "cooked" }] },
      },
    });
    expect(error).toBeNull();
    expect((data as { status?: string })?.status).toBe("applied");

    const item = await admin.from("recipe_items").select("seq, qty, unit, grams")
      .eq("food_ref_id", foodRefId).single();
    expect(item.error).toBeNull();
    expect(item.data).toMatchObject({ seq: 1, qty: 1, unit: "g", grams: 100 });

    const snapshot = await a.client.rpc("compute_item_snapshot",
      { p_food_ref_id: foodRefId, p_grams: 100 });
    expect(snapshot.error).toBeNull();
    const amounts = snapshot.data as Record<string, { amount: number }>;
    expect(amounts.energy_kcal.amount).toBe(165);
    expect(amounts.protein.amount).toBe(31);
  }, 30000);
});
