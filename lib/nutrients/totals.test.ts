import { describe, expect, it } from "vitest";
import type { NutrientCode } from "./codes";
import { computeSnapshot, type SnapshotMeta } from "./snapshot";
import { microCoverage, totalsFor } from "./totals";

const meta: SnapshotMeta = { source: "fdc_foundation", source_version: "2026-04", revision_id: 7 };

function item(per100: Partial<Record<NutrientCode, number | null>>, grams: number) {
  return { snapshot: computeSnapshot(per100 as Record<NutrientCode, number | null>, grams, meta) };
}

describe("totalsFor", () => {
  it("sums measured amounts and carries the unit", () => {
    const totals = totalsFor([item({ protein: 23.1 }, 140), item({ protein: 7.5 }, 200)]);
    expect(totals.get("protein")).toEqual({ code: "protein", amount: 47.34, unit: "g",
      itemsWithValue: 2, itemsTotal: 2, coverage: 1 });
  });

  it("skips a null amount in the sum but counts it against coverage", () => {
    const totals = totalsFor([item({ iron: 2.5 }, 100), item({ iron: null }, 100)]);
    expect(totals.get("iron")).toEqual({ code: "iron", amount: 2.5, unit: "mg",
      itemsWithValue: 1, itemsTotal: 2, coverage: 0.5 });
  });

  it("counts every item of the day in the denominator, not only the ones carrying the code", () => {
    const totals = totalsFor([item({ zinc: 1.2 }, 100), item({ protein: 4 }, 100),
      item({ protein: 4 }, 100), item({ protein: 4 }, 100)]);
    expect(totals.get("zinc")).toMatchObject({ itemsWithValue: 1, itemsTotal: 4, coverage: 0.25 });
  });

  it("keeps a measured zero as a covered value", () => {
    const totals = totalsFor([item({ sugars_total: 0 }, 250)]);
    expect(totals.get("sugars_total")).toMatchObject({ amount: 0, itemsWithValue: 1, coverage: 1 });
  });

  it("is empty for no items", () => {
    expect(totalsFor([]).size).toBe(0);
  });
});

describe("microCoverage", () => {
  it("counts a tracked micro as covered only when an item measured it", () => {
    const totals = totalsFor([item({ iron: 2.5, calcium: null, protein: 10 }, 100)]);
    expect(microCoverage(totals)).toEqual({ covered: 1, tracked: 12, pct: 8 });
  });

  it("reports 7 of 12 as 58 percent", () => {
    const totals = totalsFor([item({ fiber_total: 4, iron: 1, calcium: 20, potassium: 100,
      magnesium: 12, zinc: 1, vitamin_c: 3 }, 100)]);
    expect(microCoverage(totals)).toEqual({ covered: 7, tracked: 12, pct: 58 });
  });

  it("takes a narrower code list when one is given", () => {
    const totals = totalsFor([item({ iron: 2.5 }, 100)]);
    expect(microCoverage(totals, ["iron", "zinc"])).toEqual({ covered: 1, tracked: 2, pct: 50 });
  });

  it("is zero percent, never NaN, for an empty tracked list", () => {
    expect(microCoverage(new Map(), [])).toEqual({ covered: 0, tracked: 0, pct: 0 });
  });
});
