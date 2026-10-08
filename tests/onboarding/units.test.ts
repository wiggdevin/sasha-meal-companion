// Onboarding v2 P0 (2026-10-07 live QA: "all users are in the US and still kg and cm were used").
import { describe, expect, it } from "vitest";
import {
  ageFromBirthYear, birthYearFromAge, cmFromHeightFields, displayHeight, displayWeight,
  heightFields, kgFromWeightField, onboardingUnitsFor, parseHeightInput, parseWeightInput,
  weightFieldValue,
} from "@/lib/onboarding/units";

describe("onboarding units", () => {
  it("defaults a new account to ft/in and lb, and keeps an account's own metric choice", () => {
    expect(onboardingUnitsFor(null)).toEqual({ height: "ft_in", weight: "lb" });
    expect(onboardingUnitsFor({ heightUnit: "cm", weightUnit: "kg" })).toEqual({ height: "cm", weight: "kg" });
  });

  it("round-trips the QA answers: 165 cm / 68 kg show as 5 ft 5 in / 150 lb and store metric", () => {
    expect(heightFields(165)).toEqual({ ft: 5, in: 5 });
    expect(displayHeight(165, "ft_in")).toBe("5 ft 5 in");
    expect(displayWeight(68, "lb")).toBe("150 lb");
    expect(weightFieldValue(68, "lb")).toBe("149.9");
    expect(cmFromHeightFields(5, 5)).toBe(165.1);
    expect(kgFromWeightField("150", "lb")).toBe(68.039);
    expect(kgFromWeightField("68", "kg")).toBe(68);
  });

  it.each([
    ["5'5\"", 165.1], ["5’5", 165.1], ["5 ft 5", 165.1], ["5 feet 5 inches", 165.1], ["65 in", 165.1],
    ["5", 152.4], ["165 cm", 165], ["1.65 m", 165],
  ])("reads the typed height %s", (text, cm) => {
    expect(parseHeightInput(text as string, "ft_in")).toBe(cm);
  });

  it("reads a bare number in the field's unit and refuses nonsense", () => {
    expect(parseHeightInput("165", "cm")).toBe(165);
    expect(parseHeightInput("165", "ft_in")).toBeNull();
    expect(parseHeightInput("9'2", "ft_in")).toBeNull();
    expect(parseWeightInput("150", "lb")).toBe(68.039);
    expect(parseWeightInput("68 kg", "lb")).toBe(68);
    expect(parseWeightInput("150 lbs", "kg")).toBe(68.039);
    expect(parseWeightInput("5", "lb")).toBeNull();
    expect(parseWeightInput("heavy", "lb")).toBeNull();
  });

  it("asks age, stores a birth year", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(birthYearFromAge(25, now)).toBe(2001);
    expect(ageFromBirthYear(2001, now)).toBe(25);
    expect(birthYearFromAge(7, now)).toBeNull();
  });
});
