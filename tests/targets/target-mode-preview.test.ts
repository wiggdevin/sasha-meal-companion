// tests/targets/target-mode-preview.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewGrams, targetModeRequest } from "@/components/TargetModeSheet";
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

// Audit A054: a manual revision is dated by the phone's day, not the UTC date.
describe("targetModeRequest", () => {
  let savedTz: string | undefined;
  beforeEach(() => { savedTz = process.env.TZ; process.env.TZ = "America/Los_Angeles"; });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("dates a save at 6 pm Pacific by that evening's date, not the next UTC day", () => {
    const evening = new Date("2026-10-11T01:00:00.000Z"); // 18:00 Oct 10 in Los Angeles
    const grams = { proteinG: 140, fatG: 70, carbG: 200 };
    expect(targetModeRequest("grams", { kcalTrain: 2200, kcalRest: 1800 },
      { proteinPct: 30, fatPct: 30, carbPct: 40 }, grams, evening))
      .toEqual({ mode: "grams", effectiveFrom: "2026-10-10", kcalTrain: 2200, kcalRest: 1800, grams });
  });
});
