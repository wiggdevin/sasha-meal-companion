import { describe, expect, it } from "vitest";
import type { NutrientCode } from "./codes";
import { computeSnapshot, round4, snapshotsEqual, snapshotValue, type SnapshotMeta } from "./snapshot";

const meta: SnapshotMeta = { source: "fdc_sr_legacy", source_version: "2026-04", revision_id: 41 };

function per100(over: Partial<Record<NutrientCode, number | null>>) {
  return over as Record<NutrientCode, number | null>;
}

describe("round4", () => {
  it("rounds half away from zero at the fourth decimal, like Postgres numeric", () => {
    expect(round4(0.55355)).toBe(0.5536);
    expect(round4(0.55354)).toBe(0.5535);
    expect(round4(1.00005)).toBe(1.0001);
    expect(round4(12)).toBe(12);
  });
});

describe("computeSnapshot", () => {
  it("scales per-100 g values by grams and rounds to 4 dp", () => {
    const snap = computeSnapshot(per100({ protein: 23.1, energy_kcal: 179 }), 140, meta);
    expect(snapshotValue(snap, "protein")).toEqual({ amount: 32.34, unit: "g",
      basis: "per_100g", source: "fdc_sr_legacy", source_version: "2026-04", revision_id: 41 });
    expect(snapshotValue(snap, "energy_kcal")?.amount).toBe(250.6);
  });

  it("keeps null as null and a measured zero as zero", () => {
    const snap = computeSnapshot(per100({ iron: null, sugars_total: 0 }), 200, meta);
    expect(snapshotValue(snap, "iron")?.amount).toBeNull();
    expect(snapshotValue(snap, "sugars_total")?.amount).toBe(0);
  });

  it("writes no entry for a code the source does not carry", () => {
    const snap = computeSnapshot(per100({ protein: 10 }), 100, meta);
    expect(snapshotValue(snap, "zinc")).toBeUndefined();
    expect(Object.keys(snap)).toEqual(["protein"]);
  });

  it("passes a supplied unit through and falls back to the canonical one", () => {
    const snap = computeSnapshot(per100({ vitamin_d: 1.2, calcium: 30 }), 50,
      { ...meta, units: { vitamin_d: "IU" } });
    expect(snapshotValue(snap, "vitamin_d")?.unit).toBe("IU");
    expect(snapshotValue(snap, "calcium")?.unit).toBe("mg");
  });

  it("returns an empty snapshot for zero grams with every amount at zero, not null", () => {
    const snap = computeSnapshot(per100({ protein: 23.1 }), 0, meta);
    expect(snapshotValue(snap, "protein")?.amount).toBe(0);
  });

  it("rejects negative grams", () => {
    expect(() => computeSnapshot(per100({ protein: 1 }), -1, meta)).toThrow(/grams/);
  });
});

describe("exact-decimal parity with round(numeric, 4)", () => {
  it("treats the input as the decimal Postgres receives, not the double", () => {
    // 1.2 + 15 * 0.11 is 2.8499999999999996 as a double; Postgres gets that string and computes
    // 2.8499999999999996 × 212.5 / 100 = 6.05624999999999915 → 6.0562, never 6.0563.
    const snap = computeSnapshot(per100({ fiber_total: 1.2 + 15 * 0.11 }), 212.5, meta);
    expect(snapshotValue(snap, "fiber_total")?.amount).toBe(6.0562);
  });

  it("rounds a true decimal midpoint half away from zero", () => {
    expect(computeSnapshot(per100({ protein: 2.85 }), 212.5, meta).protein.amount).toBe(6.0563);
    expect(round4(6.05625)).toBe(6.0563);
  });

  it("keeps grams like 37 and 212.5 exact", () => {
    expect(computeSnapshot(per100({ energy_kcal: 159.5 }), 212.5, meta).energy_kcal.amount).toBe(338.9375);
    expect(computeSnapshot(per100({ sodium: 195 }), 37, meta).sodium.amount).toBe(72.15);
  });
});

describe("snapshotsEqual", () => {
  const a = computeSnapshot(per100({ protein: 23.1, iron: null }), 140, meta);

  it("is true for the same amounts and units from a different source revision", () => {
    const b = computeSnapshot(per100({ protein: 23.1, iron: null }), 140,
      { source: "fdc_sr_legacy", source_version: "2026-07", revision_id: 99 });
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it("is false when one side measured a nutrient the other did not", () => {
    const b = computeSnapshot(per100({ protein: 23.1, iron: 1.2 }), 140, meta);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("is false on a different code set", () => {
    const b = computeSnapshot(per100({ protein: 23.1 }), 140, meta);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("tolerates a difference inside epsilon and rejects one outside", () => {
    const near = computeSnapshot(per100({ protein: 23.1001, iron: null }), 140, meta);
    expect(snapshotsEqual(a, near, 0.02)).toBe(true);
    expect(snapshotsEqual(a, near, 0.0001)).toBe(false);
  });
});
