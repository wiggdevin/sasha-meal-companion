/**
 * Audit 2026-10-18 §11: nutrient codes and sync errors never reach the screen as raw strings.
 */
import { describe, expect, it } from "vitest";
import { NUTRIENT_CODES, nutrientLabel, TRACKED_MICROS, visibleNutrientCodes } from "@/lib/nutrients/codes";
import { syncErrorCopy } from "@/components/SyncStatus";

describe("nutrientLabel", () => {
  it("gives every code a label with no underscore or database abbreviation", () => {
    for (const code of NUTRIENT_CODES) {
      const label = nutrientLabel(code);
      expect(label).not.toMatch(/_|\b(rae|dfe|calc|kcal)\b/i);
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
    expect(TRACKED_MICROS.map(nutrientLabel)).toContain("Folate");
    expect(nutrientLabel("vitamin_a_rae")).toBe("Vitamin A");
  });

  it("makes an unknown code readable", () => {
    expect(nutrientLabel("omega_3")).toBe("Omega 3");
  });
});

describe("visibleNutrientCodes", () => {
  it("shows one Calories row: reported when it has a value, else calculated", () => {
    const codes = ["energy_kcal", "energy_kcal_calc", "protein"];
    expect(visibleNutrientCodes(codes)).toEqual(["energy_kcal", "protein"]);
    expect(visibleNutrientCodes(codes, (c) => c !== "energy_kcal")).toEqual(["energy_kcal_calc", "protein"]);
    expect(visibleNutrientCodes(["energy_kcal_calc", "fat_total"])).toEqual(["energy_kcal_calc", "fat_total"]);
  });
});

describe("syncErrorCopy", () => {
  it("never shows a path, verb or status code", () => {
    expect(syncErrorCopy("GET /api/sync/changes?since=4 failed with 500")).toBe("Couldn't sync just now");
    expect(syncErrorCopy("POST /api/sync/ops failed with 401")).toBe("Sign in again to sync");
    expect(syncErrorCopy("Failed to fetch")).toBe("Couldn't reach the server");
    expect(syncErrorCopy("Load failed")).toBe("Couldn't reach the server");
    expect(syncErrorCopy("Food snapshot page did not advance food:abc")).toBe("Couldn't sync just now");
  });
});
