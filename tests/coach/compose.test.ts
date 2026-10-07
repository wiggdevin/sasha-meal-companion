import { describe, expect, it, vi } from "vitest";
import { clampMealTarget, composeMeal, wishTerms } from "@/lib/coach/compose";
import { fitNote, fitsTarget, macroSources, roleOf, sizeItems } from "@/lib/coach/compose-size";
import { composedActions, slotLabel } from "@/components/CoachComposedCard";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import type { FoodHit } from "@/lib/coach/executors";

const REF = (n: string) => `3f1b1a2c-0000-4000-8000-0000000000${n}`;

const chicken: FoodHit = { foodRefId: REF("c1"), name: "Chicken breast, roasted", brand: null,
  kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, prefStatus: "eats",
  catalogFoodRevisionId: 11, allergenTags: [], category: null };
const wheatWrap: FoodHit = { foodRefId: REF("w1"), name: "Tortilla, wheat", brand: null,
  kcalPer100g: 310, proteinPer100g: 8, carbsPer100g: 52, fatPer100g: 7, prefStatus: null,
  catalogFoodRevisionId: 12, allergenTags: ["gluten"], category: null };
const cornWrap: FoodHit = { foodRefId: REF("w2"), name: "Tortilla, corn", brand: null,
  kcalPer100g: 220, proteinPer100g: 6, carbsPer100g: 45, fatPer100g: 3, prefStatus: "eats",
  catalogFoodRevisionId: 13, allergenTags: [], category: null };
const avocado: FoodHit = { foodRefId: REF("a1"), name: "Avocado, raw", brand: null,
  kcalPer100g: 160, proteinPer100g: 2, carbsPer100g: 9, fatPer100g: 15, prefStatus: "eats",
  catalogFoodRevisionId: 14, allergenTags: [], category: null };

const TARGET = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

function search(byTerm: Record<string, FoodHit[]>) {
  return vi.fn(async (_u: string, q: string) => (byTerm[q] ?? []) as never);
}

describe("reading the wish", () => {
  it("keeps the foods and drops the filler", () => {
    expect(wishTerms("Can you give me a recipe for a chicken wrap that fits my daily macros?"))
      .toEqual(["chicken", "wrap"]);
  });

  it("takes at most four terms, without repeats", () => {
    expect(wishTerms("chicken chicken rice beans avocado salsa onion"))
      .toEqual(["chicken", "rice", "beans", "avocado"]);
  });

  it("reads a food's role off its own macros", () => {
    expect(roleOf(chicken)).toBe("protein");
    expect(roleOf(cornWrap)).toBe("carb");
    expect(roleOf(avocado)).toBe("fat");
  });
});

describe("composing a meal", () => {
  it("uses the next meal target without exceeding any remaining macro", () => {
    const remaining = { kcal: 1400, protein: 80, carbs: 160, fat: 40 };
    const nextSlot = { kcal: 600, protein: 45, carbs: 70, fat: 50 };

    expect(clampMealTarget(nextSlot, remaining))
      .toEqual({ kcal: 600, protein: 45, carbs: 70, fat: 40 });
  });

  it("anchors a suggestion on the requested Eats-list protein", async () => {
    const meal = await composeMeal("u1", {
      wish: "something filling",
      target: TARGET,
      anchorProtein: "Chicken breast, roasted",
    }, DEFAULT_PROFILE, {
      searchFoods: search({ "Chicken breast, roasted": [chicken] }),
      eatsNames: async () => ["Chicken breast, roasted"],
    });

    expect(meal.items[0].name).toBe("Chicken breast, roasted");
    expect(meal.anchorProtein).toBe("Chicken breast, roasted");
  });

  it("does not use an excluded food while composing an anchored suggestion", async () => {
    const meal = await composeMeal("u1", {
      wish: "chicken avocado",
      target: TARGET,
      anchorProtein: "Chicken breast, roasted",
      exclude: ["Avocado, raw"],
    }, DEFAULT_PROFILE, {
      searchFoods: search({
        "Chicken breast, roasted": [chicken], chicken: [chicken], avocado: [avocado],
      }),
      eatsNames: async () => ["Chicken breast, roasted", "Avocado, raw"],
    });

    expect(meal.items.map((item) => item.name)).not.toContain("Avocado, raw");
  });

  it("swaps a blocked food for a constraint-safe one from the same search", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET },
      DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [wheatWrap, cornWrap] }) });
    expect(meal.items.map((i) => i.name)).toEqual(["Chicken breast, roasted", "Tortilla, corn"]);
    expect(meal.items[1].insteadOf).toBe("Tortilla, wheat");
    expect(meal.flagged).toEqual([]);
  });

  it("keeps the blocked food and MARKS it when no safe alternative exists", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET },
      DEFAULT_PROFILE, { searchFoods: search({ chicken: [chicken], wrap: [wheatWrap] }) });
    expect(meal.items.map((i) => i.name)).toEqual(["Chicken breast, roasted", "Tortilla, wheat"]);
    expect(meal.flagged).toEqual(["Tortilla, wheat"]);
    expect(meal.items[1].verdict).toBe("blocked");
  });

  it("sizes the grams so the totals land within 10 % of the target", async () => {
    const meal = await composeMeal("u1",
      { wish: "chicken wrap avocado", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap], avocado: [avocado] }) });
    expect(meal.items).toHaveLength(3);
    // Phase 18 W9 (D12): sized by `sizePlate` (lib/meals/size.ts), the daily layout's own
    // band-based sizer, not the old item-by-item `sizeItems` proportional pass — close to the
    // target, not pinned to its exact 10 % fit-bar (that's `fitsTarget`'s own, separate check).
    expect(Math.abs(meal.totals.protein - TARGET.protein)).toBeLessThanOrEqual(TARGET.protein * 0.15);
  });

  it("carries the target through when nothing can be sized to it", async () => {
    const meal = await composeMeal("u1", { wish: "zzzz", target: TARGET },
      DEFAULT_PROFILE, { searchFoods: search({}) });
    expect(meal.items).toEqual([]);
    expect(meal.fitsTarget).toBe(false);
    expect(meal.target).toEqual(TARGET);
  });

  it("never invents a food ref: a hit with no ref is skipped", async () => {
    const meal = await composeMeal("u1", { wish: "chicken", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [{ ...chicken, foodRefId: null }] }) });
    expect(meal.items).toEqual([]);
  });

  it("splits one macro across the foods that carry it", () => {
    const grams = sizeItems([{ hit: chicken }, { hit: chicken }],
      { kcal: 700, protein: 60, carbs: 0, fat: 0 });
    expect(grams[0]).toBe(grams[1]);
    expect(grams[0] * 2 * 0.31).toBeGreaterThan(50);
  });
});

describe("the composed card's three buttons", () => {
  const meal = {
    wish: "chicken wrap", slot: "meal-2", items: [{
      name: "Chicken breast, roasted", foodRefId: REF("c1"), catalogFoodRevisionId: 11,
      grams: 145, kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
      macros: { kcal: 239, protein: 45, carbs: 0, fat: 5.2 }, verdict: "allowed" as const,
    }],
    totals: { kcal: 239, protein: 45, carbs: 0, fat: 5.2 }, target: TARGET,
    flagged: [], fitsTarget: true,
  };
  let n = 0;
  const clock = { date: "2026-09-16", at: "15:30" };
  const actions = composedActions(meal, meal.slot, clock, () => `id-${n += 1}`);

  it("logs it as a SNACK at her current time, whatever slot the card offers", () => {
    // "Log it" means she is eating this now: an extra, not a plan slot she has ticked off
    // (spec §4, Grok pass 2, HIGH 1). Only "Put it in <slot>" touches the plan.
    expect(actions.log).toMatchObject({ kind: "log_meal", date: "2026-09-16", slot: "snack",
      at: "15:30" });
    expect(actions.log.kind === "log_meal" && actions.log.items[0].foodRefId).toBe(REF("c1"));
  });

  it("puts it in the named slot as one set_slot_meal", () => {
    expect(actions.slot).toMatchObject({ kind: "set_slot_meal", slot: "meal-2" });
  });

  it("saves it as a recipe named after the wish", () => {
    expect(actions.recipe).toMatchObject({ kind: "save_recipe", name: "chicken wrap" });
  });

  it("offers no slot button when nothing is pending, and still logs as a snack", () => {
    const loose = composedActions({ ...meal, slot: null }, null, clock, () => "id-x");
    expect(loose.slot).toBeNull();
    expect(loose.log).toMatchObject({ slot: "snack" });
  });

  it("keeps Log it a snack even when the slot button points at a meal", () => {
    expect(composedActions(meal, "meal-2", clock, () => "id-y").log)
      .toMatchObject({ kind: "log_meal", slot: "snack" });
    expect(composedActions(meal, "meal-2", clock, () => "id-y").slot)
      .toMatchObject({ kind: "set_slot_meal", slot: "meal-2" });
  });

  it("names the account's meal slot without assuming meal times", () => {
    expect(slotLabel("meal-2")).toBe("Meal 2");
    expect(slotLabel("meal-6")).toBe("Meal 6");
  });
});

describe("the fit bar", () => {
  const target = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

  it("passes only when EVERY macro is within 10 % of the per-meal target", () => {
    expect(fitsTarget({ kcal: 700, protein: 45, carbs: 70, fat: 22 }, target)).toBe(true);
    expect(fitsTarget({ kcal: 735, protein: 49, carbs: 76, fat: 24 }, target)).toBe(true);
  });

  it("fails on protein first — the number that never moves", () => {
    expect(fitsTarget({ kcal: 700, protein: 30, carbs: 70, fat: 22 }, target)).toBe(false);
  });

  it("fails on a macro that is not protein, however good the protein is", () => {
    expect(fitsTarget({ kcal: 700, protein: 45, carbs: 70, fat: 60 }, target)).toBe(false);
    expect(fitsTarget({ kcal: 1400, protein: 45, carbs: 70, fat: 22 }, target)).toBe(false);
  });

  it("ignores a target macro of zero rather than calling it a miss", () => {
    expect(fitsTarget({ kcal: 700, protein: 45, carbs: 70, fat: 5 },
      { ...target, fat: 0 })).toBe(true);
  });
});

describe("her foods first", () => {
  const jerky: FoodHit = { foodRefId: REF("j1"), name: "Beef jerky", brand: null,
    kcalPer100g: 410, proteinPer100g: 33, carbsPer100g: 30, fatPer100g: 16, prefStatus: "eats",
    catalogFoodRevisionId: 15, allergenTags: [], category: null, portionGrams: 28 };
  const fatChicken: FoodHit = { foodRefId: REF("f1"), name: "Fat, chicken", brand: null,
    kcalPer100g: 900, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100, prefStatus: null,
    catalogFoodRevisionId: 16, allergenTags: [], category: null, portionGrams: 13 };
  const pouch: FoodHit = { foodRefId: REF("p1"), name: "Fruit pouches, apple", brand: null,
    kcalPer100g: 60, proteinPer100g: 0, carbsPer100g: 14, fatPer100g: 0, prefStatus: null,
    catalogFoodRevisionId: 17, allergenTags: [], category: null, portionGrams: 90 };
  const avoided: FoodHit = { ...cornWrap, foodRefId: REF("w9"), name: "Tortilla, corn (avoided)",
    prefStatus: "avoid" };

  it("searches her own name for a term her Eats list covers", async () => {
    const searchFoods = vi.fn(async (_u: string, q: string) =>
      (q === "Chicken breast, roasted" ? [chicken] : [fatChicken]) as never);
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods, eatsNames: async () => ["Chicken breast, roasted", "Beef jerky"] });
    expect(meal.items[0].name).toBe("Chicken breast, roasted");
    expect(searchFoods).toHaveBeenCalledWith("u1", "Chicken breast, roasted", 3);
  });

  it("falls back to the catalog only for a term her list has nothing for", async () => {
    const searchFoods = vi.fn(async (_u: string, q: string) =>
      (q === "wrap" ? [cornWrap] : [chicken]) as never);
    const meal = await composeMeal("u1", { wish: "wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods, eatsNames: async () => ["Beef jerky"] });
    expect(meal.items[0].name).toBe("Tortilla, corn");
    expect(searchFoods).toHaveBeenCalledWith("u1", "wrap", 3);
  });

  it("never proposes a food on her Avoid list", async () => {
    const meal = await composeMeal("u1", { wish: "wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ wrap: [avoided, cornWrap] }), eatsNames: async () => [] });
    expect(meal.items.map((i) => i.name)).toEqual(["Tortilla, corn"]);
  });

  it("never proposes a pouch", async () => {
    const meal = await composeMeal("u1", { wish: "pouches", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ pouches: [pouch] }), eatsNames: async () => [] });
    expect(meal.items).toEqual([]);
  });

  it("sizes a single named food inside its own portion band, never an unbounded guess", async () => {
    // Phase 18 W9 (D12): a direct wish's grams come from `sizePlate`'s band model
    // (lib/meals/size.ts `unitBand`/`roundWithin`), not the old "twice the household portion"
    // rule specific to `sizeItems` — bounded is still bounded, just by the shared engine's own
    // rule, not a `compose`-only one.
    const meal = await composeMeal("u1", { wish: "jerky", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ jerky: [jerky] }), eatsNames: async () => [] });
    expect(meal.items[0].grams).toBeGreaterThan(0);
    expect(meal.items[0].grams).toBeLessThanOrEqual(4 * 28);
  });
});

describe("the one food she did not name", () => {
  const eatsAvocado: FoodHit = { ...avocado, prefStatus: "eats" };
  const eatsOil: FoodHit = { foodRefId: REF("o1"), name: "Olive oil", brand: null,
    kcalPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100, prefStatus: "eats",
    catalogFoodRevisionId: 21, allergenTags: [], category: null, portionGrams: 14 };
  const avoidedAvocado: FoodHit = { ...avocado, foodRefId: REF("a9"),
    name: "Avocado, raw (avoided)", prefStatus: "avoid" };
  const applePouch: FoodHit = { foodRefId: REF("p2"), name: "Fruit pouches, apple", brand: null,
    kcalPer100g: 60, proteinPer100g: 0, carbsPer100g: 14, fatPer100g: 9, prefStatus: "eats",
    catalogFoodRevisionId: 22, allergenTags: [], category: null, portionGrams: 90 };

  /** A wrap and chicken carry no fat, which is the case the ruling is about. */
  const wrapPorts = (extra: Record<string, FoodHit[]> = {}) => ({
    searchFoods: search({ chicken: [chicken], wrap: [cornWrap], ...extra }),
    eatsNames: async () => Object.keys(extra).length > 0 ? Object.keys(extra) : [],
  });

  // Phase 18 W9 (D12): a direct wish fills a missing part from the Eats-list pool through the
  // same `rankPinnedPlates` the daily layout uses, not the old per-item `addedFor` complement —
  // a pool-filled row is a plate part like any other (`item.part`), not specially flagged. These
  // cases now check the pool-filled food is PRESENT, by name, instead of by `addedFor`.
  it("adds a fat from her Eats list when the named foods carry none", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      wrapPorts({ "Avocado, raw": [eatsAvocado] }));
    expect(meal.items.map((item) => item.name)).toContain("Avocado, raw");
    expect(meal.totals.fat).toBeGreaterThan(0);
  });

  it("adds at most one fat, however many macros are short", async () => {
    // "chicken wrap" already satisfies the main template (anchor + starch); the pool offers TWO
    // fats, so this proves the plate completes AND still never doubles up on the optional part.
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap], "Avocado, raw": [eatsAvocado],
        "Olive oil": [eatsOil] }),
        eatsNames: async () => ["Avocado, raw", "Olive oil"] });
    expect(meal.incomplete).toBeUndefined();
    const fats = meal.items.filter((item) => item.name === "Avocado, raw" || item.name === "Olive oil");
    expect(fats.length).toBe(1);
  });

  it("never adds a food on her Avoid list", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      wrapPorts({ "Avocado, raw (avoided)": [avoidedAvocado] }));
    expect(meal.items.map((item) => item.name)).not.toContain("Avocado, raw (avoided)");
  });

  it("never adds a pouch", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      wrapPorts({ "Fruit pouches, apple": [applePouch] }));
    expect(meal.items.map((item) => item.name)).not.toContain("Fruit pouches, apple");
  });

  it("never reaches the catalog for the addition — her list only", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap], avocado: [avocado] }),
        eatsNames: async () => [] });
    expect(meal.items.map((item) => item.name)).not.toContain("Avocado, raw");
  });

  it("adds nothing when the named foods already cover every macro", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap avocado", target: TARGET },
      DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap], avocado: [eatsAvocado],
        "Olive oil": [eatsOil] }),
        eatsNames: async () => ["Olive oil"] });
    expect(meal.items.map((item) => item.name)).not.toContain("Olive oil");
  });

  it("names the addition on the card", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      wrapPorts({ "Avocado, raw": [eatsAvocado] }));
    expect(meal.items.map((item) => item.name))
      .toEqual(expect.arrayContaining(["Chicken breast, roasted", "Tortilla, corn", "Avocado, raw"]));
  });
});

describe("the complement never doubles a macro the wish already carries", () => {
  // 26 g protein and 20 g fat per 100 g: its dominant macro is fat, so the old picker took it for
  // a fat gap and the meal came back 22 g over on protein (measured 2026-09-18).
  const groundBeef: FoodHit = { foodRefId: REF("b1"), name: "Ground beef, 80/20, cooked",
    brand: null, kcalPer100g: 272, proteinPer100g: 26, carbsPer100g: 0, fatPer100g: 20,
    prefStatus: "eats", catalogFoodRevisionId: 31, allergenTags: [], category: null,
    portionGrams: 85 };
  const eatsOil: FoodHit = { foodRefId: REF("o1"), name: "Olive oil", brand: null,
    kcalPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100, prefStatus: "eats",
    catalogFoodRevisionId: 21, allergenTags: [], category: null, portionGrams: 14 };

  it("skips a food that also carries the macro the wish's own food supplies", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap],
          "Ground beef, 80/20, cooked": [groundBeef], "Olive oil": [eatsOil] }),
        eatsNames: async () => ["Ground beef, 80/20, cooked", "Olive oil"] });
    // Phase 18 W9 (D12): ground beef is structurally a second ANCHOR/protein, which the main
    // template never allows beside one already named (chicken) — it is never a candidate for
    // any part this plate still needs, same as the old complement skipped it for a different
    // reason (the protein target was already covered). Olive oil, a real fat side, still fills
    // the template's optional fat part.
    const names = meal.items.map((item) => item.name);
    expect(names).not.toContain("Ground beef, 80/20, cooked");
    expect(names).toContain("Olive oil");
  });

  it("adds nothing at all rather than a second source of a covered macro", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: TARGET }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap],
          "Ground beef, 80/20, cooked": [groundBeef] }),
        eatsNames: async () => ["Ground beef, 80/20, cooked"] });
    expect(meal.items.filter((item) => item.addedFor)).toEqual([]);
  });

  it("reads which macros a food is a real source of", () => {
    expect([...macroSources(groundBeef)].sort()).toEqual(["fat", "protein"]);
    expect([...macroSources(eatsOil)]).toEqual(["fat"]);
    expect([...macroSources(chicken)]).toEqual(["protein"]);
  });
});

describe("the named protein holds its share", () => {
  // A wrap sized to a 95 g carb target carries 12.6 g protein on its own, which left 9.4 g for the
  // chicken — 30 g of chicken in a "chicken wrap" (measured 2026-09-18).
  const BIG_CARB = { kcal: 600, protein: 22, carbs: 95, fat: 15 };

  it("never sizes the named protein below half its share of the slot", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target: BIG_CARB },
      DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap] }), eatsNames: async () => [] });
    const named = meal.items.find((item) => item.name === "Chicken breast, roasted");
    expect(named?.grams).toBeGreaterThanOrEqual(35);
  });
});

describe("the card says when the meal cannot fit the slot", () => {
  const target = { kcal: 700, protein: 45, carbs: 70, fat: 22 };

  it("names the macro, the direction and the size of the miss", () => {
    expect(fitNote({ kcal: 700, protein: 67, carbs: 70, fat: 22 }, target))
      .toBe("Over on protein by 22 g for this slot");
    expect(fitNote({ kcal: 700, protein: 45, carbs: 52, fat: 22 }, target))
      .toBe("Under on carbs by 18 g for this slot");
    expect(fitNote({ kcal: 900, protein: 45, carbs: 70, fat: 22 }, target))
      .toBe("Over on kcal by 200 kcal for this slot");
  });

  it("says nothing when the meal fits", () => {
    expect(fitNote({ kcal: 700, protein: 45, carbs: 70, fat: 22 }, target)).toBeNull();
  });

  it("puts the line on the meal whenever the fit bar fails", async () => {
    const meal = await composeMeal("u1", { wish: "chicken wrap", target }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken], wrap: [cornWrap] }), eatsNames: async () => [] });
    expect(meal.fitsTarget).toBe(false);
    expect(meal.fitNote).toBe(fitNote(meal.totals, meal.target));
    expect(meal.fitNote).toMatch(/for this slot$/);
  });

  it("shows no fit line, and names the reason instead, for an incoherent named combination", async () => {
    // Phase 18 W9 (D12, acceptance 2): "chicken" alone cannot satisfy the main template (anchor
    // + starch) with no pool to fill it from, so the card comes back `incomplete` with NO fit
    // claim — never the old sizer's "over/under" line for a draft that was never really sized.
    const meal = await composeMeal("u1", { wish: "chicken", target }, DEFAULT_PROFILE,
      { searchFoods: search({ chicken: [chicken] }), eatsNames: async () => [] });
    expect(meal.fitsTarget).toBe(false);
    expect(meal.fitNote).toBeNull();
    expect(meal.incomplete).toBeDefined();
    expect(meal.items.map((item) => item.name)).toEqual(["Chicken breast, roasted"]);
  });
});
