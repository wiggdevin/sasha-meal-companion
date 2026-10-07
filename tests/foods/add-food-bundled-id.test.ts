/**
 * A bundled food added to My Foods takes the account's own `user_foods` id — the same id
 * `adoptBundledFood` writes (`bundledFoodUserId(id, userId)`), so the food in the list and its
 * server row are one food. A food already added under the legacy global id is re-added as itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogRow } from "@/lib/catalog-client";
import { searchFoods } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const adopt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/foods/adopt-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/adopt-client")>();
  return { ...actual, adoptBundledFood: adopt };
});

import { addBundledRow } from "@/components/AddFoodSheet";
import { bundledFoodUserId } from "@/lib/foods/adopt-client";

const bean = searchFoods("bean").find((hit) => hit.source === "db")!;
const row = { offline: true, offlineFoodId: bean.id, offlineSource: "db" } as unknown as CatalogRow;
let h: AccountHandle;

beforeEach(async () => {
  h = await resetTestAccount();
  adopt.mockReset();
  adopt.mockResolvedValue({ foodRefId: "ref", per100g: {} });
});

describe("addBundledRow", () => {
  it("adds a new bundled food under the account's own adopted id", async () => {
    const food = await addBundledRow(row, {}, h);
    expect(food.id).toBe(await bundledFoodUserId(bean.id, h.userId));
    expect(food.id).not.toBe(await bundledFoodUserId(bean.id));
    expect(adopt).toHaveBeenCalledWith(bean.id, { account: h });
  });

  it("re-adds a food stored under the legacy global id as itself, without adopting again", async () => {
    const legacy = await bundledFoodUserId(bean.id);
    const prior: Food = { id: legacy, name: "Renamed beans", role: "carb", unit: "g",
      perUnit: { protein: 1, carbs: 2, fat: 3 }, status: "neutral", updatedAt: "2026-01-01T00:00:00.000Z" };
    const food = await addBundledRow(row, { [legacy]: prior }, h);
    expect(food).toMatchObject({ id: legacy, name: "Renamed beans", status: "eats" });
    expect(adopt).not.toHaveBeenCalled();
  });
});
