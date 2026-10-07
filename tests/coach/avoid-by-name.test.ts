/**
 * "Add watermelon to my avoid list" has to mean every watermelon — readiness pass 2026-09-18.
 *
 * The mark used to write ONE `food_ref` id. The catalog holds six watermelon rows, so the next
 * grounding ranked a different, unmarked row first and handed it back unflagged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { groundActions } from "@/lib/coach/ground";
import { SAME_NAME_CAP, baseFoodName, sameBaseName } from "@/lib/foods/base-name";
import { sameBaseNameFoodIds, sameNameRefIds } from "@/lib/server/catalog-names";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import type { FoodHit } from "@/lib/coach/executors";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const mocks = vi.hoisted(() => ({
  currentPrefStatus: vi.fn(), setFoodMembership: vi.fn(),
  reserveFoodMembershipIntent: vi.fn(() => ({})),
  isLatestFoodMembershipIntent: vi.fn(() => true),
  getFoods: vi.fn(() => ({})), setFoodStatus: vi.fn(),
}));
vi.mock("@/lib/foods/prefs-client", () => ({
  currentPrefStatus: mocks.currentPrefStatus,
  setFoodMembership: mocks.setFoodMembership,
  reserveFoodMembershipIntent: mocks.reserveFoodMembershipIntent,
  isLatestFoodMembershipIntent: mocks.isLatestFoodMembershipIntent,
  readFoodMembership: () => undefined,
}));
vi.mock("@/lib/store", () => ({ getFoods: mocks.getFoods, setFoodStatus: mocks.setFoodStatus }));

const { applyAvoidMark, undoAvoidMark } = await import("@/lib/coach/apply-prefs");

const REF = (n: string) => `7a2c1b3d-0000-4000-8000-0000000000${n}`;
const ID = "action-1";

const row = (n: string, name: string, prefStatus: "avoid" | null = null): FoodHit => ({
  foodRefId: REF(n), name, brand: null, kcalPer100g: 30, proteinPer100g: 0.6,
  carbsPer100g: 7.6, fatPer100g: 0.2, prefStatus, catalogFoodRevisionId: Number(n.slice(1)),
  allergenTags: [], category: null,
});

describe("the name a mark applies to", () => {
  it("is the first comma segment, lowercased and trimmed", () => {
    expect(baseFoodName("Watermelon, raw")).toBe("watermelon");
    expect(baseFoodName("  Watermelon, seedless, raw ")).toBe("watermelon");
    expect(baseFoodName("Watermelon juice")).toBe("watermelon juice");
  });

  it("makes two spellings of one food the same food, and a shared word not", () => {
    expect(sameBaseName("Watermelon, raw", "Watermelon, seedless, raw")).toBe(true);
    expect(sameBaseName("Watermelon, raw", "Watermelon juice")).toBe(false);
    expect(sameBaseName("Watermelon, raw", "Melon, cantaloupe, raw")).toBe(false);
  });

  it("picks every active revision that shares the base name, and no other food", () => {
    expect(sameBaseNameFoodIds([
      { catalog_food_id: 1, description: "Watermelon, raw" },
      { catalog_food_id: 2, description: "Watermelon, seedless, raw" },
      { catalog_food_id: 3, description: "Watermelon, frozen" },
      { catalog_food_id: 4, description: "Watermelon juice" },
      { catalog_food_id: 5, description: "Melon, watermelon pieces" },
    ], "Watermelon, raw")).toEqual([1, 2, 3]);
  });
});

describe("how wide a mark may go", () => {
  type Row = { catalog_food_id: number; description: string };

  /** The two `ilike` reads sameNameRefIds makes, and the mint RPC, and nothing else. */
  function stub(rows: Row[], opts: { mintError?: boolean } = {}) {
    const patterns: string[] = [];
    const client = {
      from: () => {
        const q = {
          select: () => q, eq: () => q, order: () => q,
          ilike: (_c: string, pattern: string) => { patterns.push(pattern); return q; },
          limit: (n: number) => Promise.resolve({
            data: rows.filter((row) => matches(row.description, patterns.at(-1) ?? ""))
              .slice(0, n),
            error: null,
          }),
        };
        return q;
      },
    };
    const admin = {
      rpc: async (_name: string, args: { p_catalog_food_id: number }) => opts.mintError
        ? { data: null, error: { message: "refused" } }
        : { data: REF(`z${args.p_catalog_food_id}`), error: null },
    };
    return { client, admin, patterns };
  }

  const matches = (description: string, pattern: string) => {
    const lower = description.toLowerCase();
    const p = pattern.toLowerCase().replace(/\\(.)/g, "$1");
    return p.endsWith("%") ? lower.startsWith(p.slice(0, -1)) : lower === p;
  };

  const family = (base: string, n: number, from = 1): Row[] =>
    Array.from({ length: n }, (_, i) =>
      ({ catalog_food_id: from + i, description: `${base}, kind ${i}` }));

  const call = (rows: Row[], name: string, opts: { mintError?: boolean } = {}) => {
    const { client, admin, patterns } = stub(rows, opts);
    return sameNameRefIds(client as never, admin as never, "u1", name)
      .then((refs) => ({ refs, patterns }));
  };

  it("widens a small family", async () => {
    const { refs } = await call([
      { catalog_food_id: 1, description: "Watermelon, raw" },
      { catalog_food_id: 2, description: "Watermelon, seedless, raw" },
      { catalog_food_id: 3, description: "Watermelon" },
      { catalog_food_id: 4, description: "Watermelon juice, canned" },
    ], "Watermelon, raw");
    expect(refs).toEqual([REF("z1"), REF("z2"), REF("z3")]);
  });

  it("widens NOTHING when the family is bigger than the cap", async () => {
    // "Oil, olive" and "Chicken, breast" name families of hundreds of USDA rows. A mark on one of
    // those must not put every oil in the catalog on her Avoid list.
    const { refs } = await call(family("Oil", SAME_NAME_CAP + 1), "Oil, olive, salad or cooking");
    expect(refs).toEqual([]);
  });

  it("widens nothing rather than part of a family when a ref cannot be minted", async () => {
    const { refs } = await call([
      { catalog_food_id: 1, description: "Watermelon, raw" },
      { catalog_food_id: 2, description: "Watermelon, seedless, raw" },
    ], "Watermelon, raw", { mintError: true });
    expect(refs).toEqual([]);
  });

  it("escapes the LIKE wildcards in her food's own name", async () => {
    const { patterns } = await call([], "50% cocoa_bar, plain");
    expect(patterns).toEqual(["50\\% cocoa\\_bar", "50\\% cocoa\\_bar,%"]);
  });
});

describe("grounding an avoid mark", () => {
  const hits = [row("a1", "Watermelon, raw"), row("a2", "Watermelon, seedless, raw"),
    row("a3", "Watermelon, frozen")];
  const ports = (sameNameRefIds?: (u: string, n: string) => Promise<string[]>) => ({
    searchFoods: async () => [hits[0]] as FoodHit[],
    newActionId: () => ID,
    ...(sameNameRefIds ? { sameNameRefIds } : {}),
  });

  it("carries every same-name ref beside the one it chose", async () => {
    const { actions } = await groundActions("u1", [{ kind: "add_to_avoid", name: "watermelon" }],
      DEFAULT_PROFILE, ports(async () => hits.map((h) => h.foodRefId as string)));
    expect(actions[0]).toMatchObject({ kind: "add_to_avoid", foodRefId: REF("a1") });
    expect((actions[0] as { alsoFoodRefIds: string[] }).alsoFoodRefIds)
      .toEqual([REF("a2"), REF("a3")]);
  });

  it("leaves a slot-item sentence on its own grounding path", async () => {
    const searchFoods = vi.fn(async () => [hits[0]] as FoodHit[]);
    const { actions } = await groundActions("u1",
      [{ kind: "set_slot_item", date: "2026-09-18", slot: "meal-2",
        name: "watermelon", grams: 150 }],
      DEFAULT_PROFILE, { searchFoods, newActionId: () => ID, sameNameRefIds: async () => [] });
    expect(actions[0]).not.toHaveProperty("alsoFoodRefIds");
    expect(searchFoods).toHaveBeenCalledTimes(1);
  });

  it("marks only the one row when the port cannot widen it", async () => {
    const { actions } = await groundActions("u1", [{ kind: "add_to_avoid", name: "watermelon" }],
      DEFAULT_PROFILE, ports());
    expect((actions[0] as { alsoFoodRefIds: string[] }).alsoFoodRefIds).toEqual([]);
  });

  it("hands back a second row of the same name FLAGGED once it carries the mark", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "set_slot_item", date: "2026-09-18", slot: "meal-2",
        name: "watermelon", grams: 150 }],
      DEFAULT_PROFILE,
      { searchFoods: async () => [row("a2", "Watermelon, seedless, raw", "avoid")],
        newActionId: () => ID });
    expect(actions[0].flagged).toEqual(["watermelon"]);
  });
});

describe("applying an avoid mark by name", () => {
  let h: AccountHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = await resetTestAccount();
    mocks.currentPrefStatus.mockResolvedValue(null);
    mocks.setFoodMembership.mockResolvedValue(undefined);
    mocks.getFoods.mockReturnValue({});
  });

  const action = {
    kind: "add_to_avoid" as const, actionId: ID, flagged: [], name: "Watermelon, raw",
    foodRefId: REF("a1"), alsoFoodRefIds: [REF("a2"), REF("a3")],
    catalogFoodRevisionId: 1, kcalPer100g: 30, proteinPer100g: 0.6, carbsPer100g: 7.6,
    fatPer100g: 0.2, verdict: "allowed" as const,
  };

  it("writes one transactional mark for the normalized name", async () => {
    const result = await applyAvoidMark(action);
    expect(mocks.setFoodMembership).toHaveBeenCalledWith("Watermelon, raw", "avoid",
      expect.objectContaining({ note: null, account: h }));
    expect(result.status === "applied" && result.token).toMatchObject({
      foodRefId: REF("a1"),
      refs: [{ refId: REF("a1") }],
    });
  });

  it("takes the normalized-name membership off again on undo", async () => {
    const applied = await applyAvoidMark(action);
    if (applied.status !== "applied") throw new Error("the mark did not apply");
    mocks.setFoodMembership.mockClear();
    await undoAvoidMark(applied.token as Parameters<typeof undoAvoidMark>[0]);
    expect(mocks.setFoodMembership).toHaveBeenCalledWith(
      "Watermelon, raw", null, { note: null, account: h },
    );
  });

  it("puts a food she had already marked Eats back to Eats, not to nothing", async () => {
    mocks.currentPrefStatus.mockResolvedValue({ status: "eats", note: "post-run" });
    const applied = await applyAvoidMark(action);
    if (applied.status !== "applied") throw new Error("the mark did not apply");
    expect(applied.token).toMatchObject({ previous: { status: "eats", note: "post-run" } });
    mocks.setFoodMembership.mockClear();
    await undoAvoidMark(applied.token as Parameters<typeof undoAvoidMark>[0]);
    expect(mocks.setFoodMembership).toHaveBeenCalledWith(
      "Watermelon, raw", "eats", { note: null, account: h },
    );
  });

  it("undoes a token carrying the normalized-name input", async () => {
    await undoAvoidMark({ kind: "add_to_avoid", foodRefId: REF("a1"), localId: null,
      name: "Watermelon, raw", previous: null } as Parameters<typeof undoAvoidMark>[0]);
    expect(mocks.setFoodMembership).toHaveBeenCalledWith(
      "Watermelon, raw", null, { note: null, account: h },
    );
  });
});
