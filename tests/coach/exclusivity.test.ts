import { beforeEach, describe, expect, it, vi } from "vitest";
import { rotationPool, type Food } from "@/lib/foods";
import {
  __resetStoreCache, getFoods, loadStore, saveStore, setFoodStatus, upsertFood,
} from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const mocks = vi.hoisted(() => ({
  currentPrefStatus: vi.fn(),
  setFoodMembership: vi.fn(),
  saveFoodNoteForRef: vi.fn(),
  reserveFoodMembershipIntent: vi.fn(() => ({})),
  isLatestFoodMembershipIntent: vi.fn(() => true),
  readFoodMembership: vi.fn(() => undefined),
}));

vi.mock("@/lib/foods/prefs-client", () => mocks);

import { applyFoodListMark, undoFoodListMark } from "@/lib/coach/apply-prefs";

const REF = (suffix: string) => `3f1b1a2c-0000-4000-8000-0000000000${suffix}`;
const refs = [REF("11"), REF("12"), REF("13")];

function mark(kind: "add_to_avoid" | "remove_from_avoid" | "add_to_eats" | "remove_from_eats"):
  Parameters<typeof applyFoodListMark>[0] {
  return {
    kind, actionId: kind, flagged: [], name: "watermelon", foodRefId: refs[0],
    alsoFoodRefIds: refs.slice(1), catalogFoodRevisionId: 7,
    kcalPer100g: 30, proteinPer100g: 0.6, carbsPer100g: 7.6, fatPer100g: 0.2,
    verdict: "allowed",
  } as Parameters<typeof applyFoodListMark>[0];
}

let h: AccountHandle;

beforeEach(async () => {
  vi.clearAllMocks();
  h = await resetTestAccount();
  mocks.currentPrefStatus.mockResolvedValue(null);
  mocks.setFoodMembership.mockResolvedValue(undefined);
  mocks.saveFoodNoteForRef.mockResolvedValue(undefined);
});

/**
 * A device holds no food until its account projects one (design §7.1), so every
 * local-projection case seeds its own row instead of leaning on a bundled seed.
 */
function seedLocalFood(): Food {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(),
  });
  __resetStoreCache();
  saveStore(loadStore(), { silent: true });
  const food: Food = {
    id: "local-watermelon", name: "watermelon", role: "carb", unit: "cup",
    perUnit: { protein: 1, carbs: 11, fat: 0 }, status: "eats",
    updatedAt: "2026-09-19T12:00:00.000Z",
  };
  upsertFood(food);
  return food;
}

describe("Eats/Avoid exclusivity", () => {
  it.each([
    ["add_to_eats", "eats"],
    ["remove_from_avoid", null],
    ["add_to_avoid", "avoid"],
    ["remove_from_eats", null],
  ] as const)("maps %s to one normalized-name membership RPC with %s", async (kind, status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 12));
    await applyFoodListMark(mark(kind));
    expect(mocks.setFoodMembership).toHaveBeenCalledTimes(1);
    expect(mocks.setFoodMembership).toHaveBeenCalledWith(
      "watermelon",
      status,
      expect.objectContaining({ note: null }),
    );
    vi.useRealTimers();
  });

  it("remove_from_avoid becomes neutral locally", async () => {
    const local = seedLocalFood();
    setFoodStatus(local.id, "avoid");

    await applyFoodListMark({ ...mark("remove_from_avoid"), name: local.name });

    expect(getFoods()[local.id].status).toBe("neutral");
  });

  it("remove_from_eats becomes neutral locally and undo restores the prior membership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 12));
    mocks.currentPrefStatus.mockResolvedValue({
      status: "eats", note: null, role: "protein", noCook: false,
    });
    const local = seedLocalFood();
    const result = await applyFoodListMark({
      ...mark("remove_from_eats"), name: local.name, foodRefId: refs[0],
    });
    expect(mocks.saveFoodNoteForRef).toHaveBeenCalledWith(refs[0],
      "removed from Favored by Sasha on 2026-09-19", h, undefined, null);
    expect(mocks.saveFoodNoteForRef.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setFoodMembership.mock.invocationCallOrder[0]);
    expect(getFoods()[local.id].status).toBe("neutral");
    if (result.status !== "applied"
      || !["add_to_avoid", "remove_from_avoid", "add_to_eats", "remove_from_eats"]
        .includes(result.token.kind)) throw new Error("expected list token");
    mocks.setFoodMembership.mockClear();
    await undoFoodListMark(result.token as Parameters<typeof undoFoodListMark>[0]);
    expect(mocks.setFoodMembership).toHaveBeenCalledWith(
      local.name, "eats", { note: null, account: h },
    );
    expect(mocks.saveFoodNoteForRef).toHaveBeenCalledWith(refs[0], null, h, undefined,
      "removed from Favored by Sasha on 2026-09-19");
    expect(getFoods()[local.id]).toMatchObject({ status: "eats" });
    vi.useRealTimers();
  });

  it("does not change the local list when the membership operation cannot be queued", async () => {
    mocks.setFoodMembership.mockRejectedValueOnce(new Error("storage failed"));
    await expect(applyFoodListMark(mark("add_to_avoid"))).rejects.toThrow("storage failed");
  });

  it('matches the RPC normalization locally: "Watermelon, raw" avoids local "watermelon"', async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(),
    });
    __resetStoreCache();
    saveStore(loadStore(), { silent: true });
    const local: Food = {
      id: "watermelon", name: "watermelon", role: "carb", unit: "cup",
      perUnit: { protein: 0.9, carbs: 11.5, fat: 0.2 },
      status: "eats", updatedAt: "2026-09-19T00:00:00.000Z",
    };
    upsertFood(local);

    await applyFoodListMark({ ...mark("add_to_avoid"), name: "Watermelon, raw" });

    expect(getFoods()[local.id].status).toBe("avoid");
    const pool = rotationPool("rest", "meal-1", {
      kcal: 500, protein: 30, carbs: 50, fat: 20,
    }, getFoods());
    expect(pool.flatMap((meal) => meal.components)
      .some((component) => component.name === local.name)).toBe(false);
  });

  it("a local food has one status and can never appear in both selectors", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(),
    });
    __resetStoreCache();
    saveStore(loadStore(), { silent: true });
    const id = Object.keys(getFoods())[0];
    setFoodStatus(id, "avoid");
    setFoodStatus(id, "neutral");
    const foods = Object.values(getFoods());
    const eatsFoods = foods.filter((food) => food.status === "eats");
    const avoidFoods = foods.filter((food) => food.status === "avoid");
    expect(eatsFoods.some((food) => food.id === id)).toBe(false);
    expect(avoidFoods.some((food) => food.id === id)).toBe(false);
  });

  it("undo restores a local food whose prior snapshot had no note", async () => {
    const food = seedLocalFood();
    setFoodStatus(food.id, "avoid", "removed from Favored by Sasha on 2026-09-19");

    await undoFoodListMark({
      kind: "remove_from_eats", foodRefId: refs[0], refs: [], localId: food.id,
      previous: null, localPrevious: { status: "eats", note: null },
    });

    expect(getFoods()[food.id]).toMatchObject({ status: "eats" });
    expect(getFoods()[food.id].note).toBeUndefined();
  });
});
