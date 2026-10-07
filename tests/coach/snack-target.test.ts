import { describe, expect, it } from "vitest";
import { snackTarget } from "@/lib/coach/compose";

describe("snackTarget", () => {
  it("scales every macro by the same calorie ratio", () => {
    expect(snackTarget(
      { kcal: 900, protein: 90, carbs: 120, fat: 30 },
      300,
    )).toEqual({ kcal: 300, protein: 30, carbs: 40, fat: 10 });
  });

  it("uses the smaller remainder when fewer than 300 kcal are left", () => {
    expect(snackTarget(
      { kcal: 240, protein: 20, carbs: 25, fat: 8 },
      300,
    )).toEqual({ kcal: 240, protein: 20, carbs: 25, fat: 8 });
  });

  it("ignores a named slot target", () => {
    expect(snackTarget(
      { kcal: 900, protein: 90, carbs: 120, fat: 30 },
      300,
      { kcal: 600, protein: 60, carbs: 70, fat: 20 },
    )).toEqual({ kcal: 300, protein: 30, carbs: 40, fat: 10 });
  });

  it("returns nothing-left when the day has no calories remaining", () => {
    expect(snackTarget(
      { kcal: 0, protein: 10, carbs: 10, fat: 5 },
      300,
    )).toBe("nothing-left");
  });
});
