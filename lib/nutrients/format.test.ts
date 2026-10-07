import { describe, expect, it } from "vitest";
import { formatAmount } from "./format";

describe("formatAmount", () => {
  it("renders an unmeasured nutrient as an em dash, never as zero", () => {
    expect(formatAmount("iron", null, "mg")).toBe("—");
    expect(formatAmount("energy_kcal", null, "kcal")).toBe("—");
  });

  it("renders a measured zero as zero", () => {
    expect(formatAmount("sugars_total", 0, "g")).toBe("0.0 g");
    expect(formatAmount("energy_kcal", 0, "kcal")).toBe("0 kcal");
  });

  it("rounds kcal to the nearest whole calorie", () => {
    expect(formatAmount("energy_kcal", 250.64, "kcal")).toBe("251 kcal");
    expect(formatAmount("energy_kcal_calc", 1999.4, "kcal")).toBe("1999 kcal");
  });

  it("rounds a macro to a tenth of a gram", () => {
    expect(formatAmount("protein", 32.34, "g")).toBe("32.3 g");
    expect(formatAmount("fiber_total", 18.05, "g")).toBe("18.1 g");
  });

  it("renders a micro to one decimal in its own unit", () => {
    expect(formatAmount("sodium", 1240.25, "mg")).toBe("1240.3 mg");
    expect(formatAmount("vitamin_d", 1.2, "µg")).toBe("1.2 µg");
  });

  it("falls back to the canonical unit when the snapshot carries none", () => {
    expect(formatAmount("calcium", 30, "")).toBe("30.0 mg");
  });
});
