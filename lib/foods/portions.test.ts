import { describe, expect, it } from "vitest";
import { buildPortions, kcalForPortion } from "./portions";

describe("kcalForPortion", () => {
  it("rounds grams × kcalPer100g / 100", () => {
    expect(kcalForPortion(85, 165)).toBe(140); // 85 * 165 / 100 = 140.25 -> 140
    expect(kcalForPortion(14, 884)).toBe(124); // 14 * 884 / 100 = 123.76 -> 124
  });

  it("is null whenever kcalPer100g is null", () => {
    expect(kcalForPortion(100, null)).toBeNull();
    expect(kcalForPortion(0, null)).toBeNull();
  });

  it("is 0 for a 0 g portion with a known energy value", () => {
    expect(kcalForPortion(0, 165)).toBe(0);
  });
});

describe("buildPortions", () => {
  it("always appends a synthetic 100 g tail, even with no real portions", () => {
    const { portions, defaultPortion } = buildPortions([], 165);
    expect(portions).toEqual([{ id: null, label: "100 g", grams: 100, kcal: 165 }]);
    expect(defaultPortion).toBeNull();
  });

  it("picks the isDefault real portion over the first one", () => {
    const real = [
      { id: "1", label: "1 cup", grams: 240, isDefault: false },
      { id: "2", label: "3 oz", grams: 85, isDefault: true },
    ];
    const { defaultPortion } = buildPortions(real, 165);
    expect(defaultPortion).toEqual({ id: "2", label: "3 oz", grams: 85, kcal: 140 });
  });

  it("falls back to the first real portion when none is marked isDefault", () => {
    const real = [
      { id: "1", label: "1 cup", grams: 240, isDefault: false },
      { id: "2", label: "3 oz", grams: 85, isDefault: false },
    ];
    const { defaultPortion } = buildPortions(real, 165);
    expect(defaultPortion).toEqual({ id: "1", label: "1 cup", grams: 240, kcal: 396 });
  });

  it("keeps real portions in the caller's order, then the 100 g tail", () => {
    const real = [
      { id: "2", label: "3 oz", grams: 85, isDefault: false },
      { id: "1", label: "1 cup", grams: 240, isDefault: false },
    ];
    const { portions } = buildPortions(real, 100);
    expect(portions).toEqual([
      { id: "2", label: "3 oz", grams: 85, kcal: 85 },
      { id: "1", label: "1 cup", grams: 240, kcal: 240 },
      { id: null, label: "100 g", grams: 100, kcal: 100 },
    ]);
  });

  it("carries a null kcalPer100g onto every portion, including the default and the tail", () => {
    const real = [{ id: "1", label: "1 tbsp", grams: 14, isDefault: true }];
    const { portions, defaultPortion } = buildPortions(real, null);
    expect(portions).toEqual([
      { id: "1", label: "1 tbsp", grams: 14, kcal: null },
      { id: null, label: "100 g", grams: 100, kcal: null },
    ]);
    expect(defaultPortion).toEqual({ id: "1", label: "1 tbsp", grams: 14, kcal: null });
  });

  it("handles a gram-only food (one real portion, no label beyond its own)", () => {
    const real = [{ id: "9", label: "1 whole", grams: 50, isDefault: true }];
    const { portions, defaultPortion } = buildPortions(real, 200);
    expect(portions).toEqual([
      { id: "9", label: "1 whole", grams: 50, kcal: 100 },
      { id: null, label: "100 g", grams: 100, kcal: 200 },
    ]);
    expect(defaultPortion?.grams).toBe(50);
  });
});
