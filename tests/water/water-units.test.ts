import { describe, expect, it } from "vitest";
import {
  defaultWaterUnit, formatWater, formatWaterDelta, formatWaterOf, stepLabel, stepPhrase, waterValue,
} from "@/lib/water-units";
import { dietPrefsWithWater, waterPrefsFrom, waterPrefsOfDietPrefs, waterUnitFor } from "@/lib/water-prefs";
import { scrubText } from "@/lib/today/water-scrub";

describe("water units", () => {
  it("reads a stored cup as 8 oz and 237 ml", () => {
    expect([waterValue(1, "oz"), waterValue(1, "cups"), waterValue(1, "ml")]).toEqual([8, 1, 237]);
    expect([waterValue(16, "oz"), waterValue(16, "ml")]).toEqual([128, 3792]);
    // A coach-logged 500 ml is 2.083 cups: whole ounces, a tenth of a cup.
    expect([waterValue(500 / 240, "oz"), waterValue(500 / 240, "cups")]).toEqual([17, 2.1]);
  });

  it("formats counts, totals and deltas in the chosen unit", () => {
    expect(formatWater(8, "oz")).toBe("64 oz");
    expect(formatWater(1, "cups")).toBe("1 cup");
    expect(formatWater(8, "ml")).toBe("1,896 ml");
    expect(formatWaterOf(4, 16, "oz")).toBe("32 of 128 oz");
    expect(formatWaterOf(4, 8, "cups")).toBe("4 of 8 cups");
    expect(formatWaterDelta(6, "oz")).toBe("+48 oz");
    expect(formatWaterDelta(-1, "cups")).toBe("−1 cup");
    expect(scrubText(6, 6, 16, "oz")).toBe("+48 oz → 96 / 128 oz");
    expect(scrubText(2, 1, 0, "cups")).toBe("+1 cup → 3 cups");
  });

  it("names one step the way each unit says it", () => {
    expect([stepPhrase("oz"), stepPhrase("cups"), stepPhrase("ml")]).toEqual(["8 oz", "a cup", "237 ml"]);
    expect([stepLabel("oz"), stepLabel("cups"), stepLabel("ml")]).toEqual(["8 oz", "Cup", "237 ml"]);
  });

  it("defaults to ounces everywhere for now", () => {
    expect(defaultWaterUnit("en-US")).toBe("oz");
    expect(defaultWaterUnit("en")).toBe("oz");
    expect(defaultWaterUnit(null)).toBe("oz");
    expect(defaultWaterUnit("en-GB")).toBe("oz");
    expect(defaultWaterUnit("fr")).toBe("oz");
    expect(defaultWaterUnit("es_US")).toBe("oz");
  });
});

describe("water preferences in diet_prefs", () => {
  it("validates what it reads", () => {
    expect(waterPrefsFrom({ unit: "cups", goal: "auto" })).toEqual({ unit: "cups", goal: "auto" });
    expect(waterPrefsFrom({ unit: "gallons", goal: "always" })).toEqual({});
    expect(waterPrefsOfDietPrefs({ flags: [], water: { unit: "ml" } })).toEqual({ unit: "ml" });
    expect(waterPrefsOfDietPrefs(null)).toEqual({});
  });

  it("merges into the stored object and keeps every dietary key", () => {
    const stored = { flags: ["no_dairy"], text: "Keep fibre gentle", lifestyle: { cookingEffort: "minimal" },
      water: { unit: "oz" } };
    expect(dietPrefsWithWater(stored, { goal: "manual" })).toEqual({ ...stored,
      water: { unit: "oz", goal: "manual" } });
    expect(dietPrefsWithWater(null, { unit: "cups" })).toEqual({ flags: [], water: { unit: "cups" } });
  });

  it("uses the chosen unit, else ounces", () => {
    expect(waterUnitFor({ unit: "cups" }, "en-GB")).toBe("cups");
    expect(waterUnitFor({}, "en-US")).toBe("oz");
    expect(waterUnitFor(undefined, "de-DE")).toBe("oz");
  });
});
