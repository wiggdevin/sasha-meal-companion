import { describe, expect, it } from "vitest";
import { planShoppingPeriod, periodWindows } from "@/lib/shopping/planner";
import { ingredient, recipe } from "../recipes/fixture";
import { identity, identityFor, period } from "./fixture";

const candidate = (partial: Parameters<typeof recipe>[0] = {}) => ({
  ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] },
});

describe("whole-period planner", () => {
  it("sizes a personal portion to the meal target and multiplies purchases for people", () => {
    const stew = candidate({ nutritionPerServing: { kcal: { value: 400,
      status: "estimated", sourceRevisionId: null } } });
    const result = planShoppingPeriod({ period: period({ people: 3 }),
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: 200 }],
      candidates: [stew], basket: [], pins: [], aggregate: { identityFor } });
    expect(result.choices[0]).toMatchObject({ servingFraction: 0.5, servingsConsumed: 1.5 });
    expect(result.shopping.lines.find((line) => line.name === "beans")?.needGrams).toBe(75);
  });
  it("prefers a protein-rich recipe over a protein-poor one at the same kcal (S3)", () => {
    const known = (value: number) => ({ value, status: "estimated" as const, sourceRevisionId: null });
    const poor = candidate({ recipeId: "poor", revisionId: "poor-v1", name: "Plain rice",
      nutritionPerServing: { kcal: known(500), protein: known(8) } });
    const rich = candidate({ recipeId: "rich", revisionId: "rich-v1", name: "Bean and egg bowl",
      nutritionPerServing: { kcal: known(500), protein: known(39) } });
    const slot = { localDate: "2026-10-01", slotId: "meal-3", targetKcal: 500, targetProtein: 40 };
    const result = planShoppingPeriod({ period: period(), slots: [slot],
      candidates: [poor, rich], basket: [], pins: [], aggregate: { identityFor } });
    // 39 of 40 g is inside the 3 % rounding band: chosen, and no shortfall named.
    expect(result.choices[0]).toMatchObject({ candidateRevisionId: "rich-v1", proteinGapGrams: -1 });
    expect(result.compromise.some((line) => /short of the protein/.test(line))).toBe(false);

    // Without a protein target the two tie on kcal and the old order stands.
    const kcalOnly = planShoppingPeriod({ period: period(), slots: [{ ...slot, targetProtein: null }],
      candidates: [poor, rich], basket: [], pins: [], aggregate: { identityFor } });
    expect(kcalOnly.choices[0].proteinGapGrams).toBeNull();
  });

  it("names a protein shortfall when the best available recipe is still short", () => {
    const known = (value: number) => ({ value, status: "estimated" as const, sourceRevisionId: null });
    const poor = candidate({ name: "Plain rice", nutritionPerServing: { kcal: known(500), protein: known(8) } });
    const result = planShoppingPeriod({ period: period(), candidates: [poor], basket: [], pins: [],
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: 500, targetProtein: 40 }],
      aggregate: { identityFor } });
    expect(result.choices[0].proteinGapGrams).toBe(-32);
    expect(result.compromise).toContain("Plain rice is 32 g short of the protein for 2026-10-01 meal-3.");
  });

  it("says so when the chosen recipe's protein is not measured", () => {
    const stew = candidate({ name: "Mystery stew", nutritionPerServing: {
      kcal: { value: 500, status: "estimated", sourceRevisionId: null } } });
    const result = planShoppingPeriod({ period: period(), candidates: [stew], basket: [], pins: [],
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: 500, targetProtein: 40 }],
      aggregate: { identityFor } });
    expect(result.choices[0].proteinGapGrams).toBeNull();
    expect(result.compromise).toContain(
      "Mystery stew's protein is not measured, so 2026-10-01 meal-3 may be short.");
  });

  it("makes weekly replenishment windows for a month and accepts custom ranges", () => {
    expect(periodWindows(period({ endDate: "2026-10-31" }))).toHaveLength(5);
    expect(periodWindows(period({ endDate: "2026-10-05" }))).toHaveLength(1);
  });

  it("enforces a strict ingredient basket including seasonings and reports unmet pins", () => {
    const result = planShoppingPeriod({
      period: period({ lockMode: "ingredients" }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [candidate()], basket: [identity("beans")], pins: [identity("beans")],
      aggregate: { identityFor },
    });
    expect(result.choices).toHaveLength(0);
    expect(result.shopping.lines).toHaveLength(0);
    expect(result.unfilledSlots[0].reasons[0]).toMatch(/including seasoning/);
    expect(result.unmetPins).toHaveLength(1);
  });

  it("requires confirmed quantity for quantity lock; unknown pantry is not unlimited", () => {
    const result = planShoppingPeriod({ period: period({ lockMode: "available_quantities" }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [candidate()], basket: [identity("beans"), identity("salt")], pins: [],
      aggregate: { identityFor, pantry: [{ id: "p", userId: "account-a", name: "beans",
        identity: identity("beans"), confirmedGrams: null, confirmedAt: "2026-09-30", revision: 1 }] },
    });
    expect(result.choices).toHaveLength(0);
    expect(result.unfilledSlots[0].reasons).toContain("Confirmed pantry quantity is insufficient or unknown.");
  });

  it("does not schedule heating steps in a no-cook plan, even if mislabeled", () => {
    const result = planShoppingPeriod({ period: period({ effort: "none" }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [candidate({ effort: "none" })], basket: [], pins: [],
      aggregate: { identityFor },
    });
    expect(result.choices).toHaveLength(0);
    expect(result.unfilledSlots[0].reasons[0]).toMatch(/no cooking/);
  });

  it("lets a no-cook recipe through and keeps short-list mode independent of skill", () => {
    const salad = candidate({ effort: "none", name: "Bean salad",
      steps: [{ seq: 1, text: "Mix the beans and salt, then serve." }] });
    const result = planShoppingPeriod({ period: period({ effort: "standard", mode: "simple" }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [salad], basket: [], pins: [], aggregate: { identityFor },
    });
    expect(result.choices).toHaveLength(1);
    const noCook = planShoppingPeriod({ period: period({ effort: "none", mode: "simple" }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [salad], basket: [], pins: [], aggregate: { identityFor },
    });
    expect(noCook.choices).toHaveLength(1);
  });

  it("uses a pin when feasible and explains incomplete budget evidence", () => {
    const salad = candidate({ recipeId: "salad", revisionId: "salad-v1", name: "Bean salad",
      effort: "none", steps: [{ seq: 1, text: "Mix the beans and oil." }],
      ingredients: [ingredient({ seq: 1, name: "beans" }), ingredient({ seq: 3, name: "oil" })] });
    const result = planShoppingPeriod({ period: period({ budgetAmount: 10 }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [candidate(), salad], basket: [identity("oil")], pins: [identity("oil")],
      aggregate: { identityFor },
    });
    expect(result.choices[0].recipe.recipeId).toBe("salad");
    expect(result.unmetPins).toEqual([]);
    expect(result.shopping.price.budgetMet).toBeNull();
    expect(result.compromise).toContainEqual(expect.stringMatching(/budget cannot be confirmed/));
  });

  it("starts a fresh batch when a new replenishment week begins", () => {
    const result = planShoppingPeriod({ period: period({ endDate: "2026-10-14" }),
      slots: [{ localDate: "2026-10-07", slotId: "dinner", targetKcal: null },
        { localDate: "2026-10-08", slotId: "dinner", targetKcal: null }],
      candidates: [candidate()], basket: [], pins: [], aggregate: { identityFor },
    });
    expect(result.choices[0].batchId).not.toBe(result.choices[1].batchId);
    expect(result.replenishment[0].lines).toHaveLength(2);
    expect(result.replenishment[1].lines).toHaveLength(2);
  });

  it("prepares a fresh batch after the storage window and at a new weekly window", () => {
    const result = planShoppingPeriod({ period: period({ endDate: "2026-10-14" }),
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: null },
        { localDate: "2026-10-04", slotId: "meal-3", targetKcal: null },
        { localDate: "2026-10-08", slotId: "meal-3", targetKcal: null }],
      candidates: [candidate()], basket: [], pins: [], aggregate: { identityFor },
    });
    expect(new Set(result.choices.map((row) => row.batchId)).size).toBe(3);
    const first = result.replenishment[0].lines.reduce((total, row) => total + (row.needGrams ?? 0), 0);
    const second = result.replenishment[1].lines.reduce((total, row) => total + (row.needGrams ?? 0), 0);
    const whole = result.shopping.lines.reduce((total, row) => total + (row.needGrams ?? 0), 0);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(first + second).toBeCloseTo(whole, 4);
  });

  it("reserves confirmed pantry once in date order and leaves unsized purchases unknown", () => {
    const plan = planShoppingPeriod({ period: period({ endDate: "2026-10-08" }),
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: null },
        { localDate: "2026-10-08", slotId: "meal-3", targetKcal: null }],
      candidates: [candidate()], basket: [], pins: [], aggregate: { identityFor,
        pantry: [{ id: "stock", userId: "account-a", name: "beans", identity: identity("beans"),
          confirmedGrams: 80, confirmedAt: "2026-09-30", revision: 1 }] } });
    const bean = plan.shopping.lines.find((line) => line.name === "beans")!;
    const weekly = plan.replenishment.map((row) => row.lines.find((line) => line.lineId === bean.id)!);
    expect(weekly.map((row) => row.needGrams)).toEqual([50, 50]);
    expect(weekly.map((row) => row.confirmedStockGrams)).toEqual([50, 30]);
    expect(weekly.map((row) => row.buyGrams)).toEqual([0, null]);
  });

  it("keeps a missing cooked-to-raw conversion unknown in every dated row", () => {
    const cooked = candidate({ ingredients: [ingredient({ seq: 1, name: "cooked rice",
      state: "cooked", purchaseGrams: null, purchaseConversionStatus: "unknown" })] });
    const plan = planShoppingPeriod({ period: period({ endDate: "2026-10-08" }),
      slots: [{ localDate: "2026-10-01", slotId: "meal-3", targetKcal: null },
        { localDate: "2026-10-08", slotId: "meal-3", targetKcal: null }],
      candidates: [cooked], basket: [], pins: [], aggregate: { identityFor } });
    for (const week of plan.replenishment) {
      expect(week.lines[0]).toMatchObject({ needGrams: null,
        confirmedStockGrams: null, buyGrams: null });
    }
  });

  it("prefers a lower sourced checkout cost when fit and hard constraints tie", () => {
    const expensive = candidate({ recipeId: "expensive", revisionId: "a-expensive",
      ingredients: [ingredient({ seq: 1, name: "steak", foodRefId: "steak" })] });
    const cheap = candidate({ recipeId: "cheap", revisionId: "z-cheap",
      ingredients: [ingredient({ seq: 1, name: "lentils", foodRefId: "lentils" })] });
    const result = planShoppingPeriod({ period: period({ budgetAmount: 20 }),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      candidates: [expensive, cheap], basket: [], pins: [], aggregate: { identityFor,
        prices: [{ identity: identity("steak"), packageGrams: 100, amount: 18,
          currency: "USD", locale: "US-CO", source: "store", observedAt: "2026-09-30" },
        { identity: identity("lentils"), packageGrams: 100, amount: 2,
          currency: "USD", locale: "US-CO", source: "store", observedAt: "2026-09-30" }] },
    });
    expect(result.choices[0].recipe.recipeId).toBe("cheap");
  });

  it("plans a kept accepted slot as-is, buys it, and never joins a new batch to it", () => {
    const chosen = candidate({ recipeId: "chosen", revisionId: "chosen-v1",
      ingredients: [ingredient({ seq: 1, name: "lentils", foodRefId: "lentils" })] });
    const other = candidate({ recipeId: "other", revisionId: "a-other-v1" });
    const result = planShoppingPeriod({ period: period({ people: 2, endDate: "2026-10-02" }),
      slots: [{ localDate: "2026-10-02", slotId: "dinner", targetKcal: null }],
      kept: [{ localDate: "2026-10-01", slotId: "dinner", recipe: chosen,
        servingFraction: 1.5, selectionId: "selection-1" }],
      candidates: [chosen, other], basket: [], pins: [identity("lentils")],
      aggregate: { identityFor } });
    const kept = result.choices.find((row) => row.keptSelectionId === "selection-1")!;
    expect(kept).toMatchObject({ localDate: "2026-10-01", slotId: "dinner",
      servingFraction: 1.5, servingsConsumed: 3, batchId: "kept:selection-1",
      preparedOn: "2026-10-01" });
    expect(kept.recipe.revisionId).toBe("chosen-v1");
    const lentils = result.shopping.lines.find((line) => line.name === "lentils")!;
    expect(lentils.sources.filter((source) => source.localDate === "2026-10-01")
      .map((source) => source.requiredGrams)).toEqual([150]);
    expect(result.unmetPins).toEqual([]);
    const fresh = result.choices.filter((row) => !row.keptSelectionId);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].batchId).not.toBe("kept:selection-1");
  });

  it("refuses a slot that is both kept and open for planning", () => {
    expect(() => planShoppingPeriod({ period: period(),
      slots: [{ localDate: "2026-10-01", slotId: "dinner", targetKcal: null }],
      kept: [{ localDate: "2026-10-01", slotId: "dinner", recipe: candidate(),
        servingFraction: 1, selectionId: "selection-1" }],
      candidates: [candidate()], basket: [], pins: [], aggregate: { identityFor } }))
      .toThrow(/kept slot/);
  });
});
