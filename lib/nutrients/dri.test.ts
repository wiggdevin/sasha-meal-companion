import { describe, expect, it } from "vitest";
import { TRACKED_MICROS } from "./codes";
import { DRI_FEMALE_19_30, fiberBandState, percentDri, type DriRow } from "./dri";
import type { NutrientTotal } from "./totals";

function total(over: Partial<NutrientTotal>): NutrientTotal {
  return { code: "iron", amount: 9, unit: "mg", itemsWithValue: 2, itemsTotal: 2,
    coverage: 1, ...over };
}
const iron: DriRow = { code: "iron", refType: "RDA", value: 18, unit: "mg" };

describe("percentDri", () => {
  it("reports the percentage to one decimal", () => {
    expect(percentDri(total({ amount: 9 }), iron)).toBe(50);
    expect(percentDri(total({ amount: 9.9 }), iron)).toBe(55);
    expect(percentDri(total({ amount: 4 }), iron)).toBe(22.2);
  });

  it("converts inside the mass family before dividing", () => {
    expect(percentDri(total({ code: "vitamin_d", amount: 0.0075, unit: "mg" }),
      { code: "vitamin_d", refType: "RDA", value: 15, unit: "µg" })).toBe(50);
  });

  it("is null with no total, no DRI row, a zero DRI or an unconvertible unit", () => {
    expect(percentDri(undefined, iron)).toBeNull();
    expect(percentDri(total({}), undefined)).toBeNull();
    expect(percentDri(total({}), { ...iron, value: 0 })).toBeNull();
    expect(percentDri(total({ unit: "kcal" }), iron)).toBeNull();
  });

  it("is null when nothing measured the nutrient", () => {
    expect(percentDri(total({ itemsWithValue: 0, amount: 0 }), iron)).toBeNull();
  });
});

describe("fiberBandState", () => {
  it("puts 19.9 under, 20 and 25 in band, 25.1 over", () => {
    expect(fiberBandState(19.9)).toBe("under");
    expect(fiberBandState(20)).toBe("in-band");
    expect(fiberBandState(25)).toBe("in-band");
    expect(fiberBandState(25.1)).toBe("over");
  });

  it("is unknown for null, and under for a logged zero", () => {
    expect(fiberBandState(null)).toBe("unknown");
    expect(fiberBandState(0)).toBe("under");
  });
});

describe("DRI_FEMALE_19_30", () => {
  it("carries exactly the twelve tracked-micro codes, once each", () => {
    const codes = DRI_FEMALE_19_30.map((r) => r.code).sort();
    expect(codes).toEqual([...TRACKED_MICROS].sort());
    expect(new Set(codes).size).toBe(12);
  });

  it("matches the seeded row for iron — value, unit and ref type", () => {
    const iron = DRI_FEMALE_19_30.find((r) => r.code === "iron");
    expect(iron).toEqual({ code: "iron", refType: "RDA", value: 18, unit: "mg" });
  });
});
