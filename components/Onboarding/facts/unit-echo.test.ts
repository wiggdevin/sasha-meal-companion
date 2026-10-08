import { describe, expect, it } from "vitest";
import {
  ageFromBirthYear, birthYearFromAge, heightImperial, weightImperial,
} from "@/components/Onboarding/facts/unit-echo";

const TODAY = new Date("2026-10-07T00:00:00.000Z");

describe("unit-echo (US accounts: imperial only, metric stored underneath)", () => {
  it("reads height back in feet and inches, never cm", () => {
    expect(heightImperial(178)).toBe("5′10″");
    expect(heightImperial(178)).not.toMatch(/cm/);
  });

  it("reads weight back in pounds, never kg", () => {
    expect(weightImperial(75)).toBe("165 lb");
    expect(weightImperial(75)).not.toMatch(/kg/);
  });

  it("maps an age to a birth year and back", () => {
    expect(birthYearFromAge(34, TODAY)).toBe(1992);
    expect(ageFromBirthYear(1992, TODAY)).toBe(34);
  });
});
