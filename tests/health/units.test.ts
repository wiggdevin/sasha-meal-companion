import { describe, expect, it } from "vitest";
import { canonicalUnit, LB_PER_KG, toCanonical } from "@/lib/health/units";

describe("toCanonical", () => {
  it("names one canonical unit per sample type", () => {
    expect(canonicalUnit("body_mass")).toBe("kg");
    expect(canonicalUnit("step_count")).toBe("count");
    expect(canonicalUnit("active_energy")).toBe("kcal");
    expect(canonicalUnit("basal_energy")).toBe("kcal");
    expect(canonicalUnit("sleep_asleep")).toBe("min");
    expect(canonicalUnit("sleep_in_bed")).toBe("min");
    expect(canonicalUnit("resting_heart_rate")).toBe("bpm");
    expect(canonicalUnit("hrv_sdnn")).toBe("ms");
    expect(canonicalUnit("readiness_score")).toBe("score");
  });

  it("converts pounds to kilograms with the pinned constant", () => {
    expect(LB_PER_KG).toBe(2.2046226218);
    // 127 / 2.2046226218 = 57.6062309912745, rounded to six places.
    expect(toCanonical("body_mass", 127, "lb")).toEqual({ value: 57.606231, unit: "kg" });
  });

  it("passes a value already canonical straight through", () => {
    expect(toCanonical("step_count", 8123, "count")).toEqual({ value: 8123, unit: "count" });
  });

  it("converts grams, hours, seconds and kilojoules", () => {
    expect(toCanonical("body_mass", 57606, "g").value).toBeCloseTo(57.606, 3);
    expect(toCanonical("sleep_asleep", 7.5, "h")).toEqual({ value: 450, unit: "min" });
    expect(toCanonical("sleep_in_bed", 28800, "s")).toEqual({ value: 480, unit: "min" });
    expect(toCanonical("active_energy", 418.4, "kJ")).toEqual({ value: 100, unit: "kcal" });
  });

  it("throws on an unknown unit rather than guessing", () => {
    expect(() => toCanonical("body_mass", 127, "stone")).toThrow(/unknown unit "stone" for body_mass/);
    expect(() => toCanonical("step_count", 10, "kcal")).toThrow(/unknown unit/);
  });
});
