/**
 * What the composer does when a meal cannot simply hit the slot — Grok pass 1, 2026-09-18.
 *
 * Which macros the SIZED meal already covers, which complement is therefore still eligible, how
 * far the named main may be squeezed, and what the card says when none of it adds up. The happy
 * path lives in tests/coach/compose.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { composeMeal } from "@/lib/coach/compose";
import { coveredMacros, fitNote, fitsTarget, sizeItems } from "@/lib/coach/compose-size";
import { fitLine } from "@/components/CoachComposedCard";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import type { FoodHit } from "@/lib/coach/executors";

const REF = (n: string) => `3f1b1a2c-0000-4000-8000-0000000000${n}`;

const chicken: FoodHit = { foodRefId: REF("c1"), name: "Chicken breast, roasted", brand: null,
  kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, prefStatus: "eats",
  catalogFoodRevisionId: 11, allergenTags: [], category: null };
const cornWrap: FoodHit = { foodRefId: REF("w2"), name: "Tortilla, corn", brand: null,
  kcalPer100g: 220, proteinPer100g: 6, carbsPer100g: 45, fatPer100g: 3, prefStatus: "eats",
  catalogFoodRevisionId: 13, allergenTags: [], category: null };

const TARGET = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

/** A meal off the wire, for the card helper that reads one. */
const STORED = { wish: "chicken wrap", slot: null, items: [], totals: TARGET, target: TARGET,
  flagged: [], fitsTarget: true };

function search(byTerm: Record<string, FoodHit[]>) {
  return vi.fn(async (_u: string, q: string) => (byTerm[q] ?? []) as never);
}

describe("what counts as covered", () => {
  const target = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

  it("reads the sized totals, not which foods were named", () => {
    expect([...coveredMacros({ kcal: 700, protein: 45, carbs: 70, fat: 4 }, target)].sort())
      .toEqual(["carb", "protein"]);
    expect([...coveredMacros({ kcal: 700, protein: 12, carbs: 8, fat: 30 }, target)])
      .toEqual(["fat"]);
  });

  it("counts a macro the slot does not ask for as covered", () => {
    expect([...coveredMacros({ kcal: 0, protein: 0, carbs: 0, fat: 0 },
      { kcal: 0, protein: 0, carbs: 0, fat: 0 })].sort()).toEqual(["carb", "fat", "protein"]);
  });

  // A fat that also carries protein is exactly what a meal short on BOTH wants. The first cut
  // rejected it because the wish happened to name a protein, however little of it was sized.
  it("leaves protein open while the sized protein is still short", () => {
    expect(coveredMacros({ kcal: 200, protein: 9, carbs: 70, fat: 4 }, target).has("protein"))
      .toBe(false);
  });
});

describe("a complement for a meal that is short on two macros", () => {
  const salmon: FoodHit = { foodRefId: REF("s1"), name: "Salmon, Atlantic, cooked", brand: null,
    kcalPer100g: 206, proteinPer100g: 22, carbsPer100g: 0, fatPer100g: 12, prefStatus: "eats",
    catalogFoodRevisionId: 41, allergenTags: [], category: null, portionGrams: 120 };
  const tinyChicken: FoodHit = { ...chicken, portionGrams: 15 };

  it("names an incomplete reason instead of a guess when no side can fill the plate", async () => {
    // Phase 18 W9 (D12): salmon is structurally an ANCHOR (`partsOf`, lib/meals/parts.ts), never
    // a fat SIDE, whatever its macro ratio says — the old "a fat by role" calorie-ratio reading
    // this test documented is exactly the loose, per-item classification the plate-search rebuild
    // replaces with the real template roles the rest of the app already uses. "chicken" alone
    // still needs a starch or vegetable the main template requires; with none offered, the card
    // is an honest `incomplete` draft, never a guessed addition.
    const meal = await composeMeal("u1", { wish: "chicken", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [tinyChicken], "Salmon, Atlantic, cooked": [salmon] }),
        eatsNames: async () => ["Salmon, Atlantic, cooked"] });
    expect(meal.incomplete).toBeDefined();
    expect(meal.items.map((item) => item.name)).toEqual(["Chicken breast, roasted"]);
  });

  it("still refuses a second protein once the sized meal covers the protein target", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap],
          "Salmon, Atlantic, cooked": [salmon] }),
        eatsNames: async () => ["Salmon, Atlantic, cooked"] });
    expect(meal.items.filter((item) => item.addedFor)).toEqual([]);
  });
});

describe("the floor under the named main", () => {
  const BIG_CARB = { kcal: 600, protein: 22, carbs: 95, fat: 15 };
  const proteinWrap: FoodHit = { ...cornWrap, proteinPer100g: 20 };

  it("never lifts a protein the named foods already cover", async () => {
    // A 210 g wrap at 20 g protein per 100 g carries 42 g against a 22 g target. Phase 18 W9
    // (D12): the direct path now sizes through `sizePlate` (lib/meals/size.ts), the daily
    // layout's shared band-based sizer, not `compose`'s own item-by-item "floor" — it still
    // keeps the chicken inside its own portion band rather than growing it past what the plate
    // needs, it just no longer lands on the old sizer's exact 15 g.
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: BIG_CARB },
      DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [proteinWrap] }),
        eatsNames: async () => [] });
    const named = meal.items.find((item) => item.name === "Chicken breast, roasted");
    expect(named?.grams).toBeGreaterThan(0);
    expect(meal.totals.protein).toBeGreaterThanOrEqual(BIG_CARB.protein);
  });

  it("lifts only the FIRST named protein, not every protein on the card", () => {
    const grams = sizeItems([{ hit: cornWrap }, { hit: chicken }, { hit: chicken }],
      { kcal: 600, protein: 22, carbs: 95, fat: 15 });
    expect(grams[1]).toBeGreaterThan(grams[2]);
  });
});

describe("a small slot's bar has a floor", () => {
  // Integration run 2026-10-17: 10 % of 10 g fat is 1 g, so the Plan sheet hid a tuna plate that
  // missed fat by 2 g and showed one idea of three for an ordinary lunch.
  const lunch = { kcal: 528, protein: 39, carbs: 72, fat: 10 };

  it("fits a miss inside 3 g or 30 kcal whatever the target", () => {
    expect(fitsTarget({ kcal: 512, protein: 40, carbs: 70, fat: 8 }, lunch)).toBe(true);
    expect(fitNote({ kcal: 512, protein: 40, carbs: 70, fat: 8 }, lunch)).toBeNull();
    expect(fitsTarget({ kcal: 60, protein: 7, carbs: 6, fat: 2 }, { kcal: 85, protein: 7, carbs: 8, fat: 4 }))
      .toBe(true);
  });

  it("never lets protein run short past 10 %", () => {
    const snack = { kcal: 120, protein: 10, carbs: 10, fat: 4 };
    expect(fitsTarget({ kcal: 112, protein: 7, carbs: 10, fat: 4 }, snack)).toBe(false);
    expect(fitsTarget({ kcal: 120, protein: 9.5, carbs: 10, fat: 4 }, snack)).toBe(true);
    expect(fitsTarget({ kcal: 130, protein: 12.5, carbs: 10, fat: 4 }, snack)).toBe(true);
  });

  it("still misses past the floor, and past 10 % on a big target", () => {
    expect(fitsTarget({ kcal: 528, protein: 39, carbs: 72, fat: 14 }, lunch)).toBe(false);
    expect(fitsTarget({ kcal: 488, protein: 39, carbs: 47, fat: 16 }, lunch)).toBe(false);
    expect(fitsTarget({ kcal: 900, protein: 80, carbs: 100, fat: 30 },
      { kcal: 900, protein: 100, carbs: 100, fat: 30 })).toBe(false);
  });
});

describe("the fit line names every macro that missed", () => {
  const target = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

  it("joins the misses into one line", () => {
    expect(fitNote({ kcal: 700, protein: 50, carbs: 70, fat: 10 }, target))
      .toBe("Over on protein by 5 g, under on fat by 12 g for this slot");
  });

  it("never prints a miss of under a gram", () => {
    expect(fitNote({ kcal: 700, protein: 45, carbs: 70, fat: 22.4 },
      { ...target, fat: 22.0001 })).toBeNull();
  });

  it("says nothing at all about a meal with no items", async () => {
    const meal = await composeMeal("u1", { wish: "zzzz", target }, DEFAULT_PROFILE,
      { searchFoods: search({}) });
    expect(meal.items).toEqual([]);
    expect(meal.fitsTarget).toBe(false);
    expect(meal.fitNote).toBeNull();
  });

  it("falls back to a plain line for a turn stored before the note existed", () => {
    expect(fitLine({ ...STORED, fitsTarget: false, fitNote: undefined }))
      .toBe("This does not quite fit the slot");
    expect(fitLine({ ...STORED, fitsTarget: true })).toBeNull();
    expect(fitLine({ ...STORED, fitsTarget: false, fitNote: "Over on protein by 5 g" }))
      .toBe("Over on protein by 5 g");
  });
});
