import { describe, expect, it } from "vitest";
import { adaptRecipeServing, recipeServingFit, suggestedServingFraction } from "@/lib/recipes/adapt";
import { ingredient, recipe } from "./fixture";

describe("recipe serving adaptation", () => {
  it("scales every line by one fraction and computes from pinned line revisions", () => {
    const adapted = adaptRecipeServing(recipe(), 1.5,
      { retainedFractionBySeq: { 1: 1, 2: 1 } });
    expect(adapted.lines.map((line) => line.grams)).toEqual([75, 75]);
    expect(adapted.lines.map((line) => line.quantity)).toEqual([75, 75]);
    expect(adapted.nutrition.kcal).toMatchObject({ value: 150, status: "known" });
    expect(adapted.exactFitAvailable).toBe(true);
  });

  it("keeps unknown retention and missing nutrient revisions out of exact-fit claims", () => {
    const candidate = recipe({ ingredients: [ingredient({ seq: 1, name: "braise",
      nutrition: { kcal: { value: 100, status: "known", sourceRevisionId: 99 } } })] });
    const adapted = adaptRecipeServing(candidate, 1, { retainedFractionBySeq: {} });
    expect(adapted.exactFitAvailable).toBe(false);
    expect(adapted.nutrition.kcal.value).toBeNull();
    expect(adapted.issues.map((issue) => issue.code)).toContain("retention_unknown");
  });

  it("rejects fractions outside recipe-specific bounds", () => {
    expect(() => adaptRecipeServing(recipe(), 3, { retainedFractionBySeq: { 1: 1, 2: 1 } }))
      .toThrow(RangeError);
  });

  it("uses explicit retained fractions for discarded liquid and leaves reduction batch macros intact", () => {
    const dish = recipe({ ingredients: [ingredient({ seq: 1, name: "marinade",
      nutrition: { kcal: { value: 200, status: "known", sourceRevisionId: 1 },
        protein: { value: 0, status: "known", sourceRevisionId: 1 },
        carbs: { value: 40, status: "known", sourceRevisionId: 1 },
        fat: { value: 0, status: "known", sourceRevisionId: 1 } } })],
      yieldGrams: 30 });
    const drained = adaptRecipeServing(dish, 1, { retainedFractionBySeq: { 1: 0.25 } });
    const retained = adaptRecipeServing(dish, 1, { retainedFractionBySeq: { 1: 1 } });
    expect(drained.nutrition.kcal.value).toBe(25);
    expect(retained.nutrition.kcal.value).toBe(100);
    expect(retained.lines[0].grams).toBe(50);
  });
});

describe("serving suggestion with a protein term (S3)", () => {
  const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
  const lean = recipe({ nutritionPerServing: { kcal: known(500), protein: known(40) } });
  const poor = recipe({ nutritionPerServing: { kcal: known(500), protein: known(10) } });

  it("proposes the kcal-matching fraction inside the practical range", () => {
    expect(suggestedServingFraction(lean, 500)).toBe(1);
    expect(suggestedServingFraction(poor, 250)).toBe(0.5);
    expect(suggestedServingFraction(poor, 5000)).toBe(2);
  });

  it("finds no better fraction by chasing protein: the kcal fit is already the product's best", () => {
    const score = (r: typeof lean, f: number, protein: number) => {
      const fit = recipeServingFit(r, f, 500, protein);
      return fit.kcalFit * fit.proteinFit;
    };
    for (const f of [0.5, 0.9, 1.05, 1.1, 1.15, 1.5, 2]) {
      expect(score(lean, f, 46)).toBeLessThan(score(lean, 1, 46));
      // The review's case: 500 kcal / 10 g against 40 g is no better at 1.5 than at the kcal match.
      expect(score(poor, f, 40)).toBeLessThanOrEqual(score(poor, 1, 40));
    }
  });

  it("scores a protein-poor recipe at the right kcal well below a protein-rich one", () => {
    const rich = recipeServingFit(lean, 1, 500, 40);
    const short = recipeServingFit(poor, 1, 500, 40);
    expect(rich).toEqual({ kcalFit: 1, proteinFit: 1, proteinGapGrams: 0 });
    expect(short.kcalFit).toBe(1);
    expect(short.proteinGapGrams).toBe(-30);
    expect(short.proteinFit).toBeLessThan(0.01);
  });

  it("treats a shortfall inside 3 % as rounding, and unknown protein as no fit", () => {
    expect(recipeServingFit(lean, 1, 500, 41).proteinFit).toBe(1);
    const unknown = recipe({ nutritionPerServing: { kcal: known(500),
      protein: { value: null, status: "unknown", sourceRevisionId: null } } });
    expect(recipeServingFit(unknown, 1, 500, 40)).toEqual({ kcalFit: 1, proteinFit: 0, proteinGapGrams: null });
    expect(recipeServingFit(unknown, 1, 500, null).proteinFit).toBe(1);
  });
});
