/**
 * t17 gap 2: an item with no known unit weight stores grams null, and `entry.grams` is only the
 * sheet's placeholder (0). The nutrient breakdown header must say the count and unit instead,
 * never "0 g", and mark the figures as partial — the same note a partly measured recipe serving
 * uses (lib/nutrition-display.ts).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NutrientBreakdown from "./NutrientBreakdown";
import type { LoggedFood, LoggedItem } from "@/lib/types";

const measuredItem: LoggedItem = {
  id: "i1", seq: 1, food_ref_id: "r1", grams: 480, qty: 2, unit: "portion",
  snapshot: { protein: { amount: 40, unit: "g", basis: "per_100g", source: "user",
    source_version: "local", revision_id: null } } as LoggedItem["snapshot"],
  foodId: "f", name: "Grandma stew", portionLabel: "cup",
  macros: { kcal: 300, protein: 40, carbs: 30, fat: 16 },
};

const unknownMassItem: LoggedItem = {
  ...measuredItem, grams: null, unit: "cup",
  snapshot: { protein: { amount: 40, unit: "g", basis: "per_unit", per_unit: 20, source: "user",
    source_version: "per_unit", revision_id: null } } as LoggedItem["snapshot"],
};

const MEASURED: LoggedFood = {
  id: "e1", foodId: "f", name: "Grandma stew", portionLabel: "cup", qty: 2, grams: 480,
  macros: { kcal: 300, protein: 40, carbs: 30, fat: 16 }, at: "2026-11-02T17:00:00.000Z",
  items: [measuredItem],
};

const UNKNOWN_MASS: LoggedFood = {
  ...MEASURED, qty: 2, grams: 0, massUnknown: true, portionLabel: "cup",
  items: [unknownMassItem],
};

describe("NutrientBreakdown", () => {
  it("heads a measured entry with its grams", () => {
    const markup = renderToStaticMarkup(<NutrientBreakdown entry={MEASURED} />);
    expect(markup).toContain("480 g");
  });

  it("heads an unknown-mass entry with its count and unit, never 0 g", () => {
    const markup = renderToStaticMarkup(<NutrientBreakdown entry={UNKNOWN_MASS} />);
    // "0 g" would be the placeholder `entry.grams` read as the amount; the per-nutrient figure
    // further down ("40.0 g") is a different, legitimate "g" and is not what this guards against.
    expect(markup).not.toContain("0 g · 1 measured item");
    expect(markup).toContain("2 × cup · 1 measured item");
  });

  it("marks an unknown-mass entry's figures as partial", () => {
    const markup = renderToStaticMarkup(<NutrientBreakdown entry={UNKNOWN_MASS} />);
    expect(markup).toContain("Partly measured");
    expect(renderToStaticMarkup(<NutrientBreakdown entry={MEASURED} />)).not.toContain("Partly measured");
  });
});
