/**
 * Live trace, 2026-10-02 (owner account, gluten and dairy avoided): every Plan sheet build ended
 * "Some foods are hidden until their labels are checked" with zero cards. The anchors were allowed
 * (plain Ahi tuna, plain chicken breast), but each card was then filled with foods that were not:
 * - the anchor's own name was used as the wish, so its words ("chicken", "cooked") pulled in more
 *   Eats foods, e.g. "Chicken breast, fried, coated … from fast food" next to a plain chicken breast;
 * - the macro complement skipped only BLOCKED foods, so an unverified "Almond butter" was taken
 *   ahead of the olive oil after it, and one unverified item discards the whole card.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { FoodHit } from "@/lib/coach/executors";
import { composeMeal } from "@/lib/coach/compose";
import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";

const PROFILE = { avoid_allergens: ["dairy", "gluten"], avoid_food_ref_ids: [], banned_categories: [] };
const TARGET = { kcal: 550, protein: 45, carbs: 50, fat: 18 };

let n = 0;
function food(name: string, per100: [number, number, number, number], over: Partial<FoodHit> = {}): FoodHit {
  n += 1;
  const [kcal, protein, carbs, fat] = per100;
  return {
    foodRefId: `3f1b1a2c-0000-4000-8000-${String(n).padStart(12, "0")}`, name, brand: null,
    kcalPer100g: kcal, proteinPer100g: protein, carbsPer100g: carbs, fatPer100g: fat,
    prefStatus: "eats", catalogFoodRevisionId: n, allergenTags: [], category: [], portionGrams: 100,
    ...over,
  };
}

const AHI = food("Ahi tuna, cooked", [130, 29, 0, 1]);
const CHICKEN = food("Chicken breast, cooked", [165, 31, 0, 4]);
// Unverified for gluten and dairy: a packaged row never clears by name.
const FRIED = food("Chicken breast, fried, coated, from fast food / restaurant", [260, 25, 9, 13], { packaged: true });
const ALMOND_BUTTER = food("Almond butter", [614, 21, 19, 56], { packaged: true });
const AVOCADO = food("Avocados, raw", [160, 2, 8.5, 14.7]);
const RICE = food("Rice, white, cooked", [130, 2.7, 28, 0.3]);
const EATS = [AHI, CHICKEN, FRIED, ALMOND_BUTTER, AVOCADO, RICE];

const search = async (_u: string, query: string) => {
  const q = query.toLowerCase();
  return EATS.filter((hit) => hit.name.toLowerCase() === q);
};

function ports(): SuggestPorts {
  return {
    userId: "u1", profile: PROFILE, target: async () => TARGET,
    eatsNames: async () => EATS.map((hit) => hit.name),
    eatsAnchors: async () => [AHI.name, CHICKEN.name],
    searchFoods: search,
    systemOne: async () => null,
    suggestionEvidence: async (_userId, items) => ({
      status: "ready", preferenceFlags: [],
      byIdentity: Object.fromEntries(items.map((item) => {
        const hit = EATS.find((f) => f.foodRefId === item.foodRefId);
        return [suggestionFoodIdentity(item), {
          allergenTags: [], policyCategories: [], noCook: null, onEatsList: true, onAvoidList: false,
          role: "protein" as const, foodName: hit?.name ?? null, foodBrand: null,
          packaged: hit?.packaged ?? false, ingredientsText: "",
          facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } },
        }];
      })),
    }),
  };
}

describe("suggestion cards are filled only with foods that pass", () => {
  it("returns cards for an allowed anchor instead of hiding them behind unverified fillers", async () => {
    const result = await suggestOptions({ kind: "meal", count: 3 }, ports());
    expect((result as { message?: string }).message).toBeUndefined();
    expect(result.length).toBeGreaterThan(0);
    const names = result.flatMap((card) => card.items.map((item) => item.name));
    expect(names).not.toContain(FRIED.name);
    expect(names).not.toContain(ALMOND_BUTTER.name);
    for (const card of result) expect(card.items.every((item) => item.verdict === "allowed")).toBe(true);
  });

  it("a suggestion's complement passes over an unverified food for the next allowed one", async () => {
    const meal = await composeMeal("u1", { wish: "meal", target: TARGET, anchorProtein: AHI.name,
      exclude: [], fillTarget: true }, PROFILE, { searchFoods: search, eatsNames: async () => EATS.map((h) => h.name) });
    const names = meal.items.map((item) => item.name);
    expect(names).not.toContain(ALMOND_BUTTER.name);
    expect(names).toContain(AVOCADO.name);
  });

  it("a direct composition still marks rather than skips (the ruling: it marks, it never refuses)", async () => {
    const meal = await composeMeal("u1", { wish: "ahi tuna with almond butter", target: TARGET },
      PROFILE, { searchFoods: search, eatsNames: async () => EATS.map((h) => h.name) });
    expect(meal.items.find((item) => item.name === ALMOND_BUTTER.name)?.verdict).toBe("unverified");
  });

  it("reaches a carb past the first eight Eats names: the pool is ordered by role, not alphabet", async () => {
    const fats = Array.from({ length: 9 }, (_, i) => food(`Almond butter ${String.fromCharCode(97 + i)}`,
      [614, 21, 19, 56], { packaged: true }));
    const eats = [AHI, AVOCADO, ...fats, RICE];
    const searchAll = async (_u: string, query: string) =>
      eats.filter((hit) => hit.name.toLowerCase() === query.toLowerCase());
    const meal = await composeMeal("u1", { wish: "meal", target: TARGET, anchorProtein: AHI.name,
      exclude: [], fillTarget: true }, PROFILE, { searchFoods: searchAll, eatsNames: async () => eats.map((h) => h.name) });
    expect(meal.items.map((item) => item.name)).toContain(RICE.name);
  });

  it("never adds the same food twice under two catalog names (\"Banana, medium\" and \"Banana, raw\")", async () => {
    const eats = [AHI, AVOCADO, food("Banana, medium", [89, 1.1, 23, 0.3], { portionGrams: 40 }), food("Banana, raw", [89, 1.1, 23, 0.3], { portionGrams: 40 })];
    const searchAll = async (_u: string, query: string) =>
      eats.filter((hit) => hit.name.toLowerCase() === query.toLowerCase());
    const meal = await composeMeal("u1", { wish: "meal", target: TARGET, anchorProtein: AHI.name,
      exclude: [], fillTarget: true }, PROFILE, { searchFoods: searchAll, eatsNames: async () => eats.map((h) => h.name) });
    expect(meal.items.filter((item) => item.name.startsWith("Banana")).length).toBeLessThanOrEqual(1);
  });

  /** Live trace 2026-10-02: food_facets held 46 human_food judgments in all, none for this
   *  account's Eats foods, and nothing warms a catalog food on the Eats list, so every card read
   *  "unverified" at the human-food gate. A plain whole food needs no model to be human food. */
  describe("the human-food gate", () => {
    const unjudged = (packagedIds: Set<string>): SuggestPorts => ({
      ...ports(),
      suggestionEvidence: async (_userId, items) => ({
        status: "ready", preferenceFlags: [],
        byIdentity: Object.fromEntries(items.map((item) => {
          const hit = EATS.find((f) => f.foodRefId === item.foodRefId);
          return [suggestionFoodIdentity(item), {
            allergenTags: [], policyCategories: [], noCook: null, onEatsList: true, onAvoidList: false,
            role: "protein" as const, foodName: hit?.name ?? null, foodBrand: null,
            packaged: packagedIds.has(item.foodRefId ?? ""), ingredientsText: "", facets: {},
          }];
        })),
      }),
    });

    it("passes a plain whole food with no human_food judgment", async () => {
      const result = await suggestOptions({ kind: "meal", count: 3 }, unjudged(new Set()));
      expect((result as { message?: string }).message).toBeUndefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it("still holds back an unjudged food that is packaged", async () => {
      const result = await suggestOptions({ kind: "meal", count: 3 },
        unjudged(new Set(EATS.map((f) => f.foodRefId as string))));
      expect(result.length).toBe(0);
    });
  });

  /** Production grounding measured 2–12 s on a phone (client_timings, 2026-09-24..10-01): each
   *  card searched its anchor and then each filler one after another, so the 5 s build ended with
   *  no card. Every name the build can need is known up front, so it is fetched in parallel. */
  it("fetches the anchors and filler pools up front, in parallel, before composing", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (_u: string, query: string) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return search(_u, query);
    };
    const result = await suggestOptions({ kind: "meal", count: 3 }, { ...ports(), searchFoods: slow });
    expect(result.length).toBeGreaterThan(0);
    expect(peak).toBeGreaterThanOrEqual(4); // both anchors and both fillers at once; 2 before
  });

  /** DeepSeek audit round 6 (LOW): a card's wish is its title on the Plan sheet, the planned slot
   *  and a saved recipe's name; with no wish of the user's it names the anchor, never "meal". */
  it("titles a no-wish card after its anchor", async () => {
    const result = await suggestOptions({ kind: "meal", count: 3 }, ports());
    expect(result.length).toBeGreaterThan(0);
    for (const card of result) expect(card.wish).toBe(card.anchorProtein);
  });

  /** Live trace 2026-10-02 (afternoon): ~27 database requests per search, ~100 searches per build,
   *  and the catalog's full-text search averaged 1.5 s under that load, so no card in 5 s. An Eats
   *  name is the account's own food: the build asks for it by exact name and searches only on a miss. */
  it("takes the account's own food by exact name and never searches the catalog for it", async () => {
    const searchFoods = vi.fn(search);
    const ownFood = vi.fn(async (_u: string, name: string) =>
      EATS.find((hit) => hit.name.toLowerCase() === name.toLowerCase()) ?? null);
    const result = await suggestOptions({ kind: "meal", count: 3 }, { ...ports(), searchFoods, ownFood });
    expect(result.length).toBeGreaterThan(0);
    expect(ownFood).toHaveBeenCalled();
    expect(searchFoods).not.toHaveBeenCalled();
  });

  it("falls back to the catalog search when no own food has the name", async () => {
    const searchFoods = vi.fn(search);
    const result = await suggestOptions({ kind: "meal", count: 3 },
      { ...ports(), searchFoods, ownFood: async () => null });
    expect(result.length).toBeGreaterThan(0);
    expect(searchFoods).toHaveBeenCalled();
  });
});
