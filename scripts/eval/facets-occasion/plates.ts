/**
 * The real plate generator for the occasion calibration eval (Acceptance 9): the production
 * ranking contract, lib/meals rankPlates, over one cuisine's labelled pantry as the account's Eats,
 * with the pantry's facet scores on the evidence ladder exactly as the snapshot hands them to the
 * phone (MealEvidence.facets, below curated, above neutral). No history: the eval measures the
 * generic priors a new account starts from.
 *
 * Each occasion gets the best plate per anchor on three fixed dates (the date rotates anchors
 * within a tier), deduplicated by plate key, so a cuisine is judged on up to a dozen distinct
 * plates rather than one.
 *
 * Pure. No I/O.
 */

import type { Food } from "@/lib/foods";
import type { MealOccasion } from "@/lib/foods/occasion-gate";
import { foodKey } from "@/lib/meals/parts";
import { bestPerAnchor, byScore, rankPlates } from "@/lib/meals/plate";
import type { MealEvidence } from "@/lib/meals/snapshot";
import type { Macros } from "@/lib/types";
import type { FacetScores, GeneratedPlate, PantryItem, PlateGenerator } from "./metrics";

const DATES = ["2026-10-05", "2026-10-06", "2026-10-07"] as const;
const PLATES_PER_OCCASION = 3;
const TARGETS: Record<MealOccasion, Macros> = {
  breakfast: { kcal: 500, protein: 30, carbs: 55, fat: 15 },
  lunch: { kcal: 650, protein: 40, carbs: 70, fat: 20 },
  dinner: { kcal: 650, protein: 40, carbs: 70, fat: 20 },
  snack: { kcal: 300, protein: 15, carbs: 30, fat: 10 },
};

/** A pantry item as an account food: per-gram macros, unit "g" (as the lib/meals fixtures). */
export function pantryFood(item: PantryItem): Food {
  return { id: item.id, name: item.food.name, role: item.role, unit: "g", status: "eats", updatedAt: "2026-10-05",
    perUnit: { protein: item.per100g.protein / 100, carbs: item.per100g.carbs / 100, fat: item.per100g.fat / 100 } };
}

/** The snapshot evidence for these foods: facet scores keyed by food key, no history. */
export function pantryEvidence(foods: readonly Food[], facets: FacetScores): MealEvidence {
  const byKey: Record<string, Partial<Record<MealOccasion, number>>> = {};
  for (const food of foods) {
    const own = facets[food.id];
    if (own) byKey[foodKey(food)] = { ...own };
  }
  return { accountId: "occasion-eval", computedAt: "2026-10-05T00:00:00.000Z", history: {}, facets: byKey };
}

export const rankPlatesGenerator: PlateGenerator = (pantry, occasion, facets): GeneratedPlate[] => {
  const foods = pantry.map(pantryFood);
  const evidence = pantryEvidence(foods, facets);
  const seen = new Set<string>();
  const out: GeneratedPlate[] = [];
  for (const date of DATES) {
    const { plates } = rankPlates({ date, slot: "meal-1", occasion, target: TARGETS[occasion], foods, evidence });
    for (const plate of bestPerAnchor(plates).sort(byScore).slice(0, PLATES_PER_OCCASION)) {
      if (seen.has(plate.key)) continue;
      seen.add(plate.key);
      out.push({ occasion, foodIds: plate.rows.map((row) => row.food.id) });
    }
  }
  return out;
};
