/**
 * W123 (T5): Log again, "You logged this before", and the Recent meals swap row.
 */
import { describe, expect, it } from "vitest";
import { logAgainRequest } from "@/lib/log/log-again";
import { canLogAgain, loggedBefore, recentMeals } from "@/lib/log/recent-meals";
import { recentSwapAlternatives } from "@/lib/today/swap-alternatives";
import type { Food } from "@/lib/foods";
import type { FoodPrefRefCache } from "@/lib/foods/prefs-client";
import type { LoggedFood, LoggedItem, StoredDay } from "@/lib/types";

const CHICKEN_REF = "aaaaaaaa-0000-4000-8000-000000000001";
const RICE_REF = "aaaaaaaa-0000-4000-8000-000000000002";

function item(ref: string, grams: number, name: string): LoggedItem {
  return { id: crypto.randomUUID(), seq: 1, food_ref_id: ref, grams, qty: grams, unit: "g",
    snapshot: {}, foodId: ref, name, portionLabel: "g", macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
}

function entry(id: string, at: string, items: LoggedItem[], extra: Partial<LoggedFood> = {}): LoggedFood {
  return { id, foodId: "meal", name: "Chicken & rice", slot: "meal-2", portionLabel: "2 items", qty: 1,
    grams: 300, macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 }, items, rev: 1, at, ...extra };
}

const MEAL = entry("11111111-0000-4000-8000-000000000001", "2026-10-10T18:00:00.000Z",
  [item(CHICKEN_REF, 150, "Chicken breast"), item(RICE_REF, 150, "Rice")]);

describe("Log again", () => {
  it("builds a new entry with new ids, the given clock and the same foods and grams", () => {
    const at = new Date("2026-10-17T12:30:00.000Z");
    const built = logAgainRequest(MEAL, at, "UTC");
    expect(built).not.toBeNull();
    const { req, card } = built!;
    expect(req.entry_id).not.toBe(MEAL.id);
    expect(card.id).toBe(req.entry_id);
    expect(req.eaten_at).toBe(at.toISOString());
    expect(req.local_date).toBe("2026-10-17");
    expect(req.base_rev).toBeUndefined();
    expect(req.items.map((i) => [i.food_ref_id, i.grams])).toEqual([[CHICKEN_REF, 150], [RICE_REF, 150]]);
    expect(req.items.map((i) => i.id)).not.toContain(MEAL.items![0].id);
    // The old entry's revision and marks are not this one's.
    expect(card.rev).toBeUndefined();
    expect(card.flags).toBeUndefined();
  });

  it("is not offered for an entry the server never took, or with a line it cannot rebuild", () => {
    expect(canLogAgain({ ...MEAL, rev: undefined })).toBe(false);
    expect(canLogAgain({ ...MEAL, localOnly: true })).toBe(false);
    expect(canLogAgain({ ...MEAL, items: [item("local:egg", 50, "Egg")] })).toBe(false);
    expect(canLogAgain({ ...MEAL, items: [{ ...item(CHICKEN_REF, 1, "Chicken"), grams: null }] })).toBe(false);
    expect(logAgainRequest({ ...MEAL, rev: undefined }, new Date(), "UTC")).toBeNull();
  });
});

describe("recent meals and 'You logged this before'", () => {
  const older = entry("11111111-0000-4000-8000-000000000002", "2026-10-08T18:00:00.000Z",
    [item(RICE_REF, 100, "Rice"), item(CHICKEN_REF, 200, "Chicken breast")]);
  const days: Record<string, StoredDay> = {
    "2026-10-08": { extras: [older] } as StoredDay,
    "2026-10-10": { extras: [MEAL] } as StoredDay,
  };

  it("keeps the newest entry per set of foods, newest first", () => {
    expect(recentMeals(days).map((row) => row.entry.id)).toEqual([MEAL.id]);
  });

  it("leaves out the viewed day and later", () => {
    expect(recentMeals(days, { before: "2026-10-10" }).map((row) => row.entry.id)).toEqual([older.id]);
  });

  it("finds the same foods logged before, and makes no claim for an unmatched line", () => {
    expect(loggedBefore(days, [RICE_REF, CHICKEN_REF])?.date).toBe("2026-10-10");
    expect(loggedBefore(days, [RICE_REF, null])).toBeNull();
    expect(loggedBefore(days, [RICE_REF])).toBeNull();
  });
});

describe("the Recent meals swap row", () => {
  const foods: Record<string, Food> = {
    chicken: { id: "chicken", name: "Chicken breast", role: "protein", unit: "g",
      perUnit: { protein: 0.31, carbs: 0, fat: 0.036 }, status: "eats", updatedAt: "2026-10-01" },
    rice: { id: "rice", name: "Rice", role: "carb", unit: "g",
      perUnit: { protein: 0.027, carbs: 0.28, fat: 0.003 }, status: "eats", updatedAt: "2026-10-01" },
  };
  const refs = { chicken: { userRefId: CHICKEN_REF }, rice: { userRefId: RICE_REF } } as unknown as FoodPrefRefCache;
  const recent = [{ id: MEAL.id, name: MEAL.name, items: MEAL.items! as unknown as Record<string, unknown>[] }];
  const target = { kcal: 450, protein: 40, carbs: 45, fat: 8 };

  it("offers a logged meal as a logged:<id> row sized to the slot", () => {
    const rows = recentSwapAlternatives({ target, foods, refs, recent });
    expect(rows.map((row) => row.id)).toEqual([`logged:${MEAL.id}`]);
    expect(rows[0].source).toBe("Recent meal");
    expect(Math.abs(rows[0].macros.kcal - target.kcal)).toBeLessThanOrEqual(target.kcal * 0.1);
  });

  it("never offers one whose food is no longer in Eats", () => {
    const { rice: _rice, ...withoutRice } = foods;
    expect(recentSwapAlternatives({ target, foods: withoutRice, refs, recent })).toEqual([]);
    const avoided = { ...foods, rice: { ...foods.rice, status: "avoid" as const } };
    expect(recentSwapAlternatives({ target, foods: avoided, refs, recent })).toEqual([]);
  });
});
