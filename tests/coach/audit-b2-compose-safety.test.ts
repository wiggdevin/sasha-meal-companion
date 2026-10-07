/**
 * 2026-10-03 audit (b2) on the meal-template composer and the portion fit:
 * - every card food is the account's own Eats row (marked Eats, same name), "allowed", never a
 *   catalog twin the search ranked first or a row that is merely "not blocked";
 * - the verdicts are taken again at the grams a resize leaves, and rounded grams stay in their box;
 * - protein portions move only toward the protein target, never as the calorie slack;
 * - a wish's "no X" / "without X" refuses X instead of adding it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));
vi.mock("@/lib/coach/policy", async (orig) => {
  const real = await orig<typeof import("@/lib/coach/policy")>();
  return { ...real, checkItem: vi.fn(real.checkItem) };
});

import type { FoodHit } from "@/lib/coach/executors";
import type { ComposedItem, ComposedMeal } from "@/lib/coach/compose";
import { isEatsRow, wishTerms } from "@/lib/coach/compose";
import { composeTemplateMeal } from "@/lib/coach/compose-template";
import { fitsTarget, macrosFor, type MealMacros } from "@/lib/coach/compose-size";
import { fitNamedMealPortions, sizeWithinBands, snap } from "@/lib/coach/fit-portions";
import { anchorSuitability, familyKey } from "@/lib/coach/meal-pairings";
import { checkItem } from "@/lib/coach/policy";
import { verdictsAt } from "@/lib/coach/suggest-candidates";
import { orderAnchors } from "@/lib/coach/suggest-anchors";
import { refusedBy, splitWish } from "@/lib/coach/wish-negation";
import { sidePartOf } from "@/lib/coach/portion-bands";
import { mealTypeAt, resolveMealClock } from "@/lib/coach/meal-type";
import { restoreSlot, skipSlot } from "@/lib/coach/actions/skip-slot";
import { logWater } from "@/lib/coach/actions/log-water";
import { wholeCups } from "@/lib/water";
import { F, FIVE_MEAL, OPEN_PROFILE, food, searchOver } from "@/tests/coach/meal-template-fixtures";

const ALL = Object.values(F);
const names = (meal: ComposedMeal) => meal.items.map((item) => item.name);

function compose(anchor: string, mealType: "breakfast" | "dinner", options: {
  foods?: FoodHit[]; search?: (u: string, q: string, l: number) => Promise<FoodHit[]>;
  eats?: string[]; userWish?: string;
} = {}) {
  const foods = options.foods ?? ALL;
  return composeTemplateMeal("u1", {
    wish: anchor, slot: "meal-3", target: FIVE_MEAL, anchorProtein: anchor, mealType,
    mealClock: mealType === "breakfast" ? "07:30" : "19:00", rotation: 0, userWish: options.userWish ?? null,
  }, OPEN_PROFILE, {
    searchFoods: options.search ?? searchOver(foods),
    eatsNames: async () => options.eats ?? foods.map((hit) => hit.name),
  });
}

describe("card foods are the account's own allowed Eats rows", () => {
  it("skips a catalog twin ranked first and uses the Eats row behind it", async () => {
    const twin = food(F.rice.name, [130, 2.7, 28, 0.3], { prefStatus: null });
    const search = async (_u: string, query: string, limit: number) => [
      ...(query === F.rice.name ? [twin] : []), ...ALL.filter((hit) => hit.name === query),
    ].slice(0, limit);
    const meal = await compose(F.chicken.name, "dinner", { search });
    const rice = meal.items.find((item) => item.name === F.rice.name);
    expect(rice?.foodRefId).toBe(F.rice.foodRefId);
    expect(meal.items.some((item) => item.foodRefId === twin.foodRefId)).toBe(false);
  });

  it("builds no card on an anchor whose only hit is not the Eats row", async () => {
    const twin = food(F.chicken.name, [165, 31, 0, 3.6], { prefStatus: null });
    const search = async (_u: string, query: string) => query === F.chicken.name ? [twin]
      : ALL.filter((hit) => hit.name === query);
    expect((await compose(F.chicken.name, "dinner", { search })).items).toEqual([]);
  });

  it("rejects an Eats-marked hit whose name is not the row searched", () => {
    expect(isEatsRow(F.rice, F.rice.name)).toBe(true);
    expect(isEatsRow({ ...F.rice, name: "Rice, brown, cooked" }, F.rice.name)).toBe(false);
    expect(isEatsRow({ ...F.rice, prefStatus: null }, F.rice.name)).toBe(false);
  });

  it("leaves a side off when its verdict is unverified, not only when it is blocked", async () => {
    const butter = food("Almond butter", [614, 21, 19, 56], { allergenTags: null });
    const foods = [F.yogurt, F.oats, F.blueberries, butter];
    const meal = await composeTemplateMeal("u1", { wish: "x", slot: "meal-1", target: FIVE_MEAL,
      anchorProtein: F.yogurt.name, mealType: "breakfast", mealClock: "07:30", rotation: 0 },
    { avoid_allergens: ["tree nuts"], avoid_food_ref_ids: [], banned_categories: [] },
    { searchFoods: searchOver(foods), eatsNames: async () => foods.map((hit) => hit.name) });
    expect(names(meal)).not.toContain(butter.name);
  });

  it("re-checks every verdict at the grams the card carries, and drops an item it cannot find", async () => {
    const items: ComposedItem[] = [F.chicken, F.rice].map((hit, index) => ({
      name: hit.name, foodRefId: hit.foodRefId!, catalogFoodRevisionId: null, grams: [140, 180][index],
      kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
      carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
      macros: macrosFor(hit, [140, 180][index]), verdict: "allowed",
    }));
    const meal = { wish: "x", slot: "meal-3", items, totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      target: FIVE_MEAL, flagged: [], fitsTarget: true } as ComposedMeal;
    vi.mocked(checkItem).mockClear();
    const ports = { searchFoods: searchOver([F.chicken]), profile: OPEN_PROFILE };
    const checked = await verdictsAt(meal, "u1", ports);
    expect(vi.mocked(checkItem).mock.calls.map(([item]) => item.grams)).toEqual([140]);
    expect(checked.items.map((item) => item.verdict)).toEqual(["allowed", "unverified"]);
  });
});

function item(hit: FoodHit, grams: number, part: ComposedItem["part"]): ComposedItem {
  return { name: hit.name, foodRefId: hit.foodRefId!, catalogFoodRevisionId: null, grams,
    kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
    carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
    macros: macrosFor(hit, grams), verdict: "allowed", part };
}

function meal(items: ComposedItem[], target: MealMacros): ComposedMeal {
  const totals = items.reduce((sum, row) => ({ kcal: sum.kcal + row.macros.kcal,
    protein: sum.protein + row.macros.protein, carbs: sum.carbs + row.macros.carbs,
    fat: sum.fat + row.macros.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { wish: "x", slot: "meal-3", items, totals, target, flagged: [],
    fitsTarget: fitsTarget(totals, target), fitNote: null };
}

describe("protein is never the calorie slack", () => {
  it("meets a calorie overshoot with the fat, leaving the protein portion that hit protein", () => {
    // Chicken carries exactly the protein; the plate is over on calories and fat.
    const target = { kcal: 230, protein: 35, carbs: 0, fat: 9 };
    const before = meal([item(F.chicken, 113, "anchor"), item(F.oil, 10, "fat")], target);
    expect(before.fitsTarget).toBe(false);
    const fitted = fitNamedMealPortions(before);
    expect(fitted.fitsTarget).toBe(true);
    expect(fitted.items[0].grams).toBe(113);
    expect(fitted.items[1].grams).toBeLessThan(10);
  });

  it("never cuts a protein-first anchor to make a plate's calories fit", () => {
    // The fit would rather cut chicken (35 g protein) than lose rice: before this it served 85 g.
    const target = { kcal: 500, protein: 42, carbs: 70, fat: 6 };
    const items = [item(F.chicken, 0, "anchor"), item(F.rice, 0, "starch"), item(F.oil, 0, "fat")];
    const sized = sizeWithinBands(items, target, [113, 250, 5]);
    expect(sized[0].grams).toBeGreaterThanOrEqual(110);
    const protein = sized.reduce((sum, row) => sum + row.macros.protein, 0);
    expect(protein).toBeGreaterThanOrEqual(target.protein * 0.9);
  });

  it("does not call a plate fitted when only cutting its protein portion would fit it", () => {
    // Chicken alone carries the protein target; the fat overshoot is not chicken's to absorb.
    const target = { kcal: 520, protein: 45, carbs: 55, fat: 9 };
    const before = meal([item(F.chicken, 129, "anchor"), item(F.rice, 180, "starch"),
      item(F.oil, 8, "fat")], target);
    const fitted = fitNamedMealPortions(before);
    expect(fitted.items[0].grams).toBe(129);
    expect(fitted.fitsTarget).toBe(false);
  });

  it("rounds into the solved box: a rounded portion never leaves its bounds", () => {
    expect(snap(37.4, 37.5, 80, 1)).toBe(38);
    expect(snap(81, 37.5, 80, 1)).toBe(80);
    expect(snap(162, 150, 175, 50)).toBe(150);
    expect(snap(160, 151, 160, 50)).toBe(160);
  });
});

describe("a wish's no means no", () => {
  it("splits refused foods out of the wish", () => {
    expect(splitWish("salmon, no banana")).toEqual({ positive: "salmon,", negated: ["banana"] });
    expect(splitWish("dinner without chicken, with rice").negated).toEqual(["chicken"]);
    expect(splitWish("dairy-free breakfast").negated).toEqual(["dairy"]);
    expect(wishTerms("salmon, no banana")).toEqual(["salmon"]);
    expect(wishTerms("chicken without rice")).toEqual(["chicken"]);
    expect(refusedBy("Bananas, raw", ["banana"])).toBe(true);
    expect(refusedBy("Licorice", ["rice"])).toBe(false);
  });

  it("does not put a refused side on the plate, and does put a wished one", async () => {
    const refused = await compose(F.yogurt.name, "breakfast", { userWish: "yogurt, no banana" });
    expect(names(refused)).not.toContain(F.banana.name);
    const wished = await compose(F.yogurt.name, "breakfast", { userWish: "yogurt with banana" });
    expect(names(wished)).toContain(F.banana.name);
  });

  it("never anchors on, or favours, a protein the wish refuses", async () => {
    const anchors = [F.chicken.name, F.salmon.name, F.steak.name];
    expect(orderAnchors(anchors, "dinner", "without chicken")).not.toContain(F.chicken.name);
    expect(anchorSuitability(F.eggs.name, "dinner", "no eggs"))
      .toBe(anchorSuitability(F.eggs.name, "dinner", null));
    expect(anchorSuitability(F.eggs.name, "dinner", "eggs please")).toBe(2);
    expect((await compose(F.chicken.name, "dinner", { userWish: "no chicken" })).items).toEqual([]);
  });
});

describe("small fixes", () => {
  it("keeps bass as bass, while scallops still fold into one family", () => {
    expect(familyKey("Bass, striped, cooked")).toBe("bass");
    expect(familyKey(F.scallopsSea.name)).toBe(familyKey(F.scallopsBay.name));
  });

  it("reads cheese and cream cheese as fat sides; cottage cheese stays a protein", () => {
    expect(sidePartOf("Cheese, cheddar")).toBe("fat");
    expect(sidePartOf("Cream cheese")).toBe("fat");
    expect(sidePartOf("Cottage cheese, lowfat")).toBeNull();
  });

  it.each([["10:29", "breakfast"], ["10:30", "lunch"], ["14:59", "lunch"], ["15:00", "snack"],
    ["17:00", "dinner"], ["22:00", "dinner"], ["22:01", "other"]] as const)(
    "the band edge %s is %s", (clock, type) => {
      expect(mealTypeAt(clock)).toBe(type);
    });

  it("a named slot reads its own clock and never falls back to the turn's", async () => {
    const timeOfDay = () => "8:00 PM";
    expect(await resolveMealClock("meal-1", { slotClock: async () => "07:30", timeOfDay })).toBe("07:30");
    expect(await resolveMealClock("meal-1", { slotClock: async () => null, timeOfDay })).toBeNull();
    expect(await resolveMealClock("meal-1", { timeOfDay })).toBeNull();
    expect(await resolveMealClock(undefined, { timeOfDay })).toBe("20:00");
  });

  it("asks about a sip under half a cup instead of logging it as a cup; 0 stays 0", async () => {
    expect([0, 20, 119, 120, 500, 600].map(wholeCups)).toEqual([0, 0, 0, 1, 2, 3]);
    const outcome = await logWater.ground({ kind: "log_water", ml: 100 } as never, {} as never);
    expect(outcome.action).toBeUndefined();
    expect(outcome.clarifications[0]).toMatch(/under half a cup/);
    expect(logWater.fastPath!.candidate({ ml: 100 } as never, "2026-10-03")).toBeNull();
    expect(logWater.card.title({ kind: "log_water", ml: 500 } as never)).toBe("Logged 2 cups (16 oz) of water");
  });

  it("dates the skip card", () => {
    const action = { kind: "skip_slot", date: "2026-10-03", slot: "meal-5", actionId: "a", flagged: [] } as const;
    expect(skipSlot.card.title(action as never)).toBe("Skipped meal 5 on Sat, Oct 3");
    expect(restoreSlot.card.title({ ...action, kind: "restore_slot" } as never))
      .toBe("Brought back meal 5 on Sat, Oct 3");
  });

  it("shows the offer's quick replies in the skip example", () => {
    const lines = skipSlot.example!.lines({ today: "2026-10-03" } as never).join("\n");
    expect(lines).toContain('"name": "quick_replies"');
    expect(lines).toContain("Skip and rebalance");
  });
});
