import { describe, expect, it } from "vitest";
import {
  applyFloors, CARB_G_MIN, FAT_G_MIN, KCAL_MIN, percentToGrams,
  resolveProfileMacros, validatePercentProfile, type MacroFloors,
} from "@/lib/targets/percent";

const FLOORS: MacroFloors = { kcalMin: KCAL_MIN, proteinGMin: 135, fatGMin: FAT_G_MIN, carbGMin: CARB_G_MIN };

describe("floor helpers", () => {
  it("keeps the non-profile minimum constants stable", () => {
    expect([KCAL_MIN, FAT_G_MIN, CARB_G_MIN]).toEqual([1650, 50, 100]);
  });
});

describe("percentToGrams", () => {
  it("converts at both day types and reconstructs the calories within ±10", () => {
    for (const kcal of [2200, 1750]) {
      const g = percentToGrams(kcal, { proteinPct: 25, fatPct: 35, carbPct: 40 });
      expect(Math.abs(4 * g.proteinG + 9 * g.fatG + 4 * g.carbG - kcal)).toBeLessThanOrEqual(10);
    }
  });
  it("gives carbs the remainder so protein and fat round cleanly", () => {
    const g = percentToGrams(2200, { proteinPct: 25, fatPct: 35, carbPct: 40 });
    expect(g.proteinG).toBe(138);
    expect(g.fatG).toBe(86);
    expect(g.carbG).toBe(219);
  });
});

describe("applyFloors — architecture §3.4 steps 1 to 6, in order", () => {
  it("leaves a compliant set alone", () => {
    const out = applyFloors(2200, { proteinG: 138, fatG: 86, carbG: 220 }, FLOORS);
    expect(out.raisedToFloor).toBe(false);
    expect(out.kcal).toBe(2200);
  });
  it("raises protein and fat to their floors and lets carbs absorb the rest", () => {
    const out = applyFloors(2200, { proteinG: 100, fatG: 40, carbG: 360 }, FLOORS);
    expect(out.grams.proteinG).toBe(135);
    expect(out.grams.fatG).toBe(50);
    expect(out.grams.carbG).toBe(Math.round((2200 - 4 * 135 - 9 * 50) / 4));
    expect(out.raisedToFloor).toBe(false);
  });
  it("raises kcal rather than cutting protein or fat when the floors do not fit (step 5)", () => {
    const out = applyFloors(900, { proteinG: 60, fatG: 20, carbG: 60 }, FLOORS);
    expect(out.grams.proteinG).toBe(135);
    expect(out.grams.fatG).toBe(50);
    expect(out.kcal).toBe(Math.max(4 * 135 + 9 * 50 + 4 * CARB_G_MIN, KCAL_MIN));
    expect(out.raisedToFloor).toBe(true);
  });
  it("never returns kcal below kcal_min (step 6)", () => {
    const out = applyFloors(1200, { proteinG: 135, fatG: 50, carbG: 0 }, FLOORS);
    expect(out.kcal).toBeGreaterThanOrEqual(KCAL_MIN);
  });
});

describe("validatePercentProfile", () => {
  it("accepts a split that clears both floors at both day types", () => {
    expect(validatePercentProfile({ proteinPct: 31, fatPct: 30, carbPct: 39 }, 2200, 1750, FLOORS))
      .toEqual({ ok: true });
  });
  it("rejects a sum that is not 100 after two decimals", () => {
    const r = validatePercentProfile({ proteinPct: 30, fatPct: 30, carbPct: 39 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({ ok: false, error: "percent_sum" });
  });
  it("rejects protein under its floor and names the minimum percentage", () => {
    const r = validatePercentProfile({ proteinPct: 20, fatPct: 30, carbPct: 50 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({ ok: false, error: "protein_below_floor" });
    if (r.ok) throw new Error("expected a rejection");
    expect(r.minProteinPct).toBeCloseTo(30.86, 2);            // 135 g × 4 ÷ 1750 × 100, rounded up
    expect(percentAt(r.minProteinPct, 1750) >= 135).toBe(true);
  });
  it("rejects fat under its floor and names the minimum percentage", () => {
    const r = validatePercentProfile({ proteinPct: 40, fatPct: 20, carbPct: 40 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({ ok: false, error: "fat_below_floor" });
    if (r.ok) throw new Error("expected a rejection");
    expect(r.minFatPct).toBeCloseTo(25.72, 2);                // 50 g × 9 ÷ 1750 × 100, rounded up
  });
  it("rejects carbs under their floor with the existing error shape", () => {
    const r = validatePercentProfile({ proteinPct: 40, fatPct: 40, carbPct: 20 }, 2200, 1750, FLOORS);
    expect(r).toMatchObject({
      ok: false,
      error: "carbs_below_floor",
      minProteinPct: 30.86,
      minFatPct: 25.72,
    });
  });
});

const percentAt = (pct: number, kcal: number) => (kcal * pct) / 100 / 4;

describe("resolveProfileMacros", () => {
  it("holds protein and fat across day types and lets carbs carry the difference", () => {
    const out = resolveProfileMacros(
      { kcalTrain: 2200, kcalRest: 1750, proteinG: 135, fatG: 85, carbG: 200 }, FLOORS);
    expect(out.training.protein).toBe(135);
    expect(out.rest.protein).toBe(135);
    expect(out.rest.carbs).toBeLessThan(out.training.carbs);
    expect(out.rest.kcal).toBeGreaterThanOrEqual(KCAL_MIN);
  });
});
