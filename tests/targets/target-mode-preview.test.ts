// tests/targets/target-mode-preview.test.ts
import { describe, expect, it } from "vitest";
import { previewGrams } from "@/components/TargetModeSheet";
import { toPounds, WEIGHT_LB_PER_KG } from "@/components/WeightTrend";
import { CARB_G_MIN, FAT_G_MIN, type MacroFloors } from "@/lib/targets/percent";

const KCAL_MIN = 1650; // a fixture account's own minimum
const FLOORS: MacroFloors = { kcalMin: KCAL_MIN, proteinGMin: 135, fatGMin: FAT_G_MIN, carbGMin: CARB_G_MIN };

describe("previewGrams", () => {
  it("shows the grams each day type produces, from the same function the server uses", () => {
    const out = previewGrams(2200, 1750, { proteinPct: 31, fatPct: 30, carbPct: 39 }, FLOORS);
    expect(out.ok).toBe(true);
    expect(out.training.proteinG).toBeGreaterThanOrEqual(135);
    expect(out.rest.proteinG).toBeGreaterThanOrEqual(135);
    expect(Math.abs(4 * out.training.proteinG + 9 * out.training.fatG + 4 * out.training.carbG - 2200))
      .toBeLessThanOrEqual(10);
  });

  it("reports the floor failure and the minimum percent instead of silently fixing it", () => {
    const out = previewGrams(2200, 1750, { proteinPct: 20, fatPct: 30, carbPct: 50 }, FLOORS);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("protein_below_floor");
    expect(out.minProteinPct).toBeCloseTo(30.86, 2);
  });

  it("reports a split that does not sum to 100", () => {
    expect(previewGrams(2200, 1750, { proteinPct: 30, fatPct: 30, carbPct: 39 }, FLOORS).error)
      .toBe("percent_sum");
  });
});

describe("toPounds", () => {
  it("converts kilograms for display and keeps nulls as gaps", () => {
    expect(WEIGHT_LB_PER_KG).toBeCloseTo(2.2046226218, 10);
    expect(toPounds([57.6, null, 57.4])).toEqual([127, null, 126.5]);
  });
});
