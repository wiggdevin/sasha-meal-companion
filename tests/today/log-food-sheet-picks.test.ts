/**
 * The sheet's picks in the durable commit's shape, and the label path that logs a typed food
 * (calc audit #15). An account food is counted in its own unit at the weight the sheet showed, so
 * the macros the user saw are the macros sent; a food that cannot be sent stays local and never
 * commits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFood, logPortionsFor, mineAsDb, searchFoods } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetFoodRefCache } from "@/lib/log-client";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const MINTED_REF = "dddddddd-0000-4000-8000-000000000001";
const spies = vi.hoisted(() => ({ commit: vi.fn(), adopt: vi.fn() }));

vi.mock("@/lib/log-commit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-commit-client")>();
  return { ...actual, commitLogEntry: spies.commit };
});
vi.mock("@/lib/foods/adopt-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/adopt-client")>();
  return { ...actual, adoptUserFood: spies.adopt };
});

import { labelCard, logLabelFood, pickForCard, sheetCard } from "@/components/LogFoodSheet.picks";
import { starterFood } from "@/lib/foods/starter";
import { preparePickedCommit } from "@/lib/log/picked-commit";

const LABEL: Food = {
  id: "bar-own", name: "Protein bar", role: "protein", unit: "oz",
  perUnit: { protein: 6, carbs: 7, fat: 2 }, status: "eats", updatedAt: "2026-11-01T00:00:00.000Z",
};
const STEW: Food = {
  id: "stew-own", name: "Grandma stew", role: "protein", unit: "cup",
  perUnit: { protein: 20, carbs: 15, fat: 8 }, status: "eats", updatedAt: "2026-11-01T00:00:00.000Z",
};

const card = (over: Partial<LoggedFood> = {}): LoggedFood => ({
  id: "c1", foodId: "x", name: "x", portionLabel: "1 each", qty: 1, grams: 0,
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, at: "2026-11-02T17:00:00.000Z", ...over,
});

beforeEach(async () => {
  await resetTestAccount();
  resetFoodRefCache();
  vi.clearAllMocks();
  spies.adopt.mockImplementation(async () => MINTED_REF);
  spies.commit.mockImplementation(async () => ({ status: "queued" }));
});

/** What the sheet shows for a portion, and what the commit would store for it. */
async function shownAndStored(food: Food, label: string, qty: number) {
  const db = mineAsDb(food);
  const portion = logPortionsFor(db).find((p) => p.label === label)!;
  const mine = { [food.id]: food };
  const shown = sheetCard(db, portion, qty, { id: `c-${label}-${qty}`, at: "2026-11-02T17:00:00.000Z" }, mine);
  const prepared = await preparePickedCommit({ picks: [pickForCard(db, shown, mine)], slot: "meal-1" });
  if (prepared.status !== "ready") throw new Error(prepared.status);
  return { shown, item: prepared.req.items[0], stored: prepared.entry };
}

describe("pickForCard", () => {
  const banana = starterFood("banana", "eats");
  const butter = starterFood("butter", "eats");

  it("stores a starter banana's 1 each at 118 g and its 100 g portion at exactly 100 g", async () => {
    const each = await shownAndStored(banana, "1 each", 1);
    expect(each.item).toMatchObject({ grams: 118, qty: 1, unit: "whole" });
    const hundred = await shownAndStored(banana, "100 g", 1);
    expect(hundred.item).toMatchObject({ grams: 100, qty: 1, unit: "portion" });
    expect(hundred.stored.grams).toBe(100);
  });

  it("stores the calories and grams the sheet showed, for every butter and banana portion", async () => {
    for (const food of [butter, banana]) {
      const labels = logPortionsFor(mineAsDb(food)).map((p) => p.label);
      expect(labels).toContain("100 g");
      for (const label of labels) {
        for (const qty of [0.25, 1, 1.75, 2.5, 7]) {
          const { shown, stored } = await shownAndStored(food, label, qty);
          const at = `${qty} × ${label} of ${food.name}`;
          expect(stored.macros, at).toEqual(shown.macros);
          expect(stored.grams, at).toBe(shown.grams);
        }
      }
    }
    // The review's case: 100 g of butter shows and stores 734 kcal, never 733 beside 734.
    expect((await shownAndStored(butter, "100 g", 1)).shown.macros.kcal).toBe(734);
  });

  it("stores the calories and grams the sheet showed for a bundled food", async () => {
    const hit = searchFoods("chicken breast roasted").find((h) => h.source === "db")!;
    const db = dbFood(hit.id)!;
    for (const portion of logPortionsFor(db)) {
      for (const qty of [0.25, 1, 1.75, 3]) {
        const shown = sheetCard(db, portion, qty, { id: `b-${portion.label}-${qty}`, at: "2026-11-02T17:00:00.000Z" }, {});
        const prepared = await preparePickedCommit({ picks: [pickForCard(db, shown, {})], slot: "meal-1" });
        if (prepared.status !== "ready") throw new Error(prepared.status);
        expect(prepared.entry.macros, `${qty} × ${portion.label}`).toEqual(shown.macros);
        expect(prepared.req.items[0].grams).toBe(shown.grams);
      }
    }
  });

  it("makes a bundled food-db card a bundled pick, untouched", () => {
    const hit = searchFoods("chicken breast roasted").find((h) => h.source === "db")!;
    const db = dbFood(hit.id)!;
    const c = card({ foodId: db.id });
    expect(pickForCard(db, c, {})).toEqual({ source: "bundled", card: c });
  });

  it("carries massUnknown from the preview onto the sheet's own card (t17 gap 3)", () => {
    const stew: Food = { id: "stew-own-2", name: "Grandma stew", role: "protein", unit: "cup",
      perUnit: { protein: 20, carbs: 15, fat: 8 }, status: "eats", updatedAt: "2026-11-01T00:00:00.000Z" };
    const db = mineAsDb(stew);
    const portion = logPortionsFor(db)[0];
    const shown = sheetCard(db, portion, 2, { id: "stew-shown", at: "2026-11-02T17:00:00.000Z" },
      { [stew.id]: stew });
    // Never the sheet's own placeholder grams: the meal card the commit builds and the card this
    // sheet shows must agree, or they would read differently for the same pick.
    expect(shown.massUnknown).toBe(true);
    expect(shown.qty).toBe(2);
  });
});

describe("logLabelFood", () => {
  it("commits a typed label once and hands back the card it filed", async () => {
    const logged = await logLabelFood(LABEL, "meal-1", new Date("2026-11-02T17:00:00.000Z"));
    expect(spies.commit).toHaveBeenCalledOnce();
    const req = spies.commit.mock.calls[0][0] as LogCommitRequest;
    expect(req.items).toMatchObject([{ food_ref_id: MINTED_REF, qty: 1, unit: "oz" }]);
    expect(logged).toMatchObject({ kind: "committed", date: req.local_date, entry: { id: req.entry_id } });
  });

  it("commits a label with no known unit weight as a count, mass unknown (t17)", async () => {
    const logged = await logLabelFood(STEW, "meal-1");
    expect(spies.commit).toHaveBeenCalledOnce();
    const req = spies.commit.mock.calls[0][0] as LogCommitRequest;
    expect(req.items[0]).toMatchObject({ grams: null, qty: 1,
      per_unit: { protein: 20, carbohydrate: 15, fat_total: 8 } });
    expect(logged).toMatchObject({ kind: "committed",
      entry: { foodId: STEW.id, massUnknown: true, macros: { protein: 20, carbs: 15, fat: 8 } } });
  });

  it("keeps nothing when the server refuses it", async () => {
    spies.commit.mockResolvedValueOnce({ status: "refused" });
    expect(await logLabelFood(LABEL, "meal-1")).toEqual({ kind: "refused",
      message: "The server would not take that one. Try again." });
  });

  it("builds the label card from the food's own unit (#383)", () => {
    const db = mineAsDb(LABEL);
    expect(labelCard(LABEL, new Date(0))).toEqual(
      sheetCard(db, db.portions[0], 1, { id: "0-lbl", at: new Date(0).toISOString() }, { [LABEL.id]: LABEL }));
    expect(labelCard(LABEL, new Date(0))).toMatchObject({ qty: 1, grams: 28.3495 });
  });
});
