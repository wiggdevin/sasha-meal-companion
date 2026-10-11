/**
 * W004 (audit 2026-10-10, A008): a recipe's energy is the sum of each ingredient's energy chosen by
 * the one energy rule (lib/nutrients/energy.ts), not two independent sums of `energy_kcal` and
 * `energy_kcal_calc`. An ingredient with only the calculated energy counts toward the recipe's
 * `energy_kcal` and toward its coverage. The SQL twin is proven on the same fixture in
 * tests/migrations/recipe-energy-rule-db.test.ts.
 */
import { describe, expect, it } from "vitest";
import { itemKcal } from "@/lib/nutrients/energy";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { computeRecipeNutrients, type Per100gByRef, type RecipeItemInput } from "@/lib/recipes/nutrients";
import { ENERGY_RULE_CASES, MEASURED_MACROS } from "@/tests/fixtures/energy-rule-cases";

function item(seq: number, ref: string, grams = 100): RecipeItemInput {
  return { seq, foodRefId: ref, qty: grams, unit: "g", grams, state: "raw" };
}

/** A fixture case as the recipe sum reads it: per-100 g amounts keyed by code. */
function per100(snapshot: Record<string, { amount: unknown }>): Record<NutrientCode, number | null> {
  const out: Record<string, unknown> = { ...MEASURED_MACROS };
  for (const [code, value] of Object.entries(snapshot)) out[code] = value.amount;
  return out as Record<NutrientCode, number | null>;
}

describe("computeRecipeNutrients applies the one energy rule per ingredient", () => {
  it("counts a calculated-only ingredient: 100 reported + 80 calculated is 180, coverage 1", () => {
    const per100g: Per100gByRef = {
      a: per100({ energy_kcal: { amount: 100 } }),
      b: per100({ energy_kcal_calc: { amount: 80 } }),
    };
    const result = computeRecipeNutrients([item(1, "a"), item(2, "b")], per100g, 1);
    expect(result.perServing.energy_kcal).toBe(180);
    expect(result.coverage).toBe(1);
    expect(result.nutritionComplete).toBe(true);
  });

  it("stores the selected energy as energy_kcal and no separate energy_kcal_calc sum", () => {
    const per100g: Per100gByRef = {
      a: per100({ energy_kcal: { amount: 100 }, energy_kcal_calc: { amount: 95 } }),
      b: per100({ energy_kcal: { amount: null }, energy_kcal_calc: { amount: 80 } }),
    };
    const result = computeRecipeNutrients([item(1, "a"), item(2, "b")], per100g, 2);
    expect(result.perServing.energy_kcal).toBe(90);
    expect(result.perServing).not.toHaveProperty("energy_kcal_calc");
    // The logged serving's snapshot reads it back through the same rule: 90, not a partial sum.
    expect(itemKcal({ energy_kcal: { amount: result.perServing.energy_kcal } })).toBe(90);
  });

  it.each(ENERGY_RULE_CASES)("one ingredient: $name", ({ snapshot, kcal }) => {
    const result = computeRecipeNutrients([item(1, "x")], { x: per100(snapshot) }, 1);
    expect(result.perServing.energy_kcal ?? null).toBe(itemKcal(snapshot));
    expect(result.perServing.energy_kcal ?? null).toBe(kcal);
    expect(result.coverage).toBe(kcal === null ? 0 : 1);
  });

  it("the whole fixture as one recipe: the sum and coverage of the selected energies", () => {
    const per100g: Per100gByRef = Object.fromEntries(
      ENERGY_RULE_CASES.map((c, i) => [`r${i}`, per100(c.snapshot)]));
    const items = ENERGY_RULE_CASES.map((_, i) => item(i + 1, `r${i}`));
    const result = computeRecipeNutrients(items, per100g, 2);
    const selected = ENERGY_RULE_CASES.map((c) => itemKcal(c.snapshot));
    const known = selected.filter((k): k is number => k !== null);
    expect(result.perServing.energy_kcal).toBe(known.reduce((a, b) => a + b, 0) / 2);
    expect(result.coverage).toBe(Math.round((known.length / items.length) * 10_000) / 10_000);
  });
});
